/**
 * Sessions and permissions. Everything is enforced on the server, per request:
 * hiding a link in the UI is not security, so every internal page AND every internal
 * API endpoint goes through requireRole('admin').
 *
 * - Session id: 32 random bytes in an HttpOnly, SameSite=Strict cookie. We store only its
 *   SHA-256 in MySQL, so a database leak does not leak live sessions.
 * - CSRF: SameSite=Strict already blocks cross-site form posts. On top of that, every HTML form
 *   carries a token derived from the session, checked on POST.
 * - A client user is bound to exactly one shop (users.shop_id). The shop they see comes from
 *   their session, never from a URL or query parameter they could edit.
 */
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { verifyPassword } from './passwords.js';

const COOKIE = 'sid';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, value, maxAgeSec) {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.web.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export async function login(res, username, password) {
  const [[user]] = await pool.query('SELECT id, username, password_hash, role, shop_id FROM users WHERE username = ?', [username]);
  // Verify against a dummy hash when the user doesn't exist, so timing doesn't reveal valid usernames.
  const ok = verifyPassword(password, user?.password_hash ?? 'scrypt$00$00');
  if (!user || !ok) return null;
  const raw = crypto.randomBytes(32).toString('base64url');
  const ttlSec = config.web.sessionTtlHours * 3600;
  await pool.query(
    'INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL ? SECOND)',
    [sha256(raw), user.id, ttlSec],
  );
  await pool.query('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP(3)'); // housekeeping
  setCookie(res, raw, ttlSec);
  return { id: user.id, username: user.username, role: user.role, shopId: user.shop_id };
}

export async function logout(req, res) {
  const raw = readCookie(req, COOKIE);
  if (raw) await pool.query('DELETE FROM sessions WHERE id_hash = ?', [sha256(raw)]);
  setCookie(res, '', 0);
}

/** Attaches req.user (or null) and a CSRF token for forms. Runs on every request. */
export async function loadSession(req, res, next) {
  req.user = null;
  const raw = readCookie(req, COOKIE);
  if (raw) {
    const [[row]] = await pool.query(
      `SELECT u.id, u.username, u.role, u.shop_id FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)`,
      [sha256(raw)],
    );
    if (row) {
      req.user = { id: row.id, username: row.username, role: row.role, shopId: row.shop_id };
      req.csrfToken = sha256(`csrf:${raw}`);
    }
  }
  res.locals.user = req.user;
  res.locals.csrfToken = req.csrfToken ?? '';
  next();
}

const wantsJson = (req) => req.path.startsWith('/api/');

export function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'not logged in' });
  return res.redirect('/login');
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (roles.includes(req.user.role)) return next();
    if (wantsJson(req)) return res.status(403).json({ error: 'forbidden' });
    return res.status(403).render('error', { title: 'Not allowed', message: 'Your account does not have access to this page.' });
  };
}

/** For HTML form posts: the hidden _csrf field must match this session's token. */
export function checkCsrf(req, res, next) {
  const sent = String(req.body?._csrf ?? '');
  const expected = req.csrfToken ?? '';
  if (expected && sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) return next();
  return res.status(403).render('error', { title: 'Form expired', message: 'Please reload the page and try again.' });
}

/** For JSON API posts: require a JSON content type. Browsers cannot send that cross-site without CORS, which we never allow. */
export function requireJsonBody(req, res, next) {
  if (req.is('application/json')) return next();
  return res.status(415).json({ error: 'expected application/json' });
}

/** Very small in-memory login throttle: 10 failed attempts per IP per 15 minutes. */
const attempts = new Map();
export function loginThrottle(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key);
  if (rec && now - rec.first < 15 * 60_000 && rec.count >= 10) {
    return res.status(429).render('login', { error: 'Too many attempts. Try again in a few minutes.', username: '' });
  }
  if (!rec || now - rec.first >= 15 * 60_000) attempts.set(key, { first: now, count: 0 });
  next();
}
export function recordFailedLogin(req) {
  const rec = attempts.get(req.ip);
  if (rec) rec.count++;
}
