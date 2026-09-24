/**
 * The web process: two pages, two roles, JSON endpoints for the same data.
 * It ONLY reads and writes MySQL. It never calls TikTok and never needs the app secret or the
 * token encryption key. "Sync now" just sets a flag the worker picks up within ~15 seconds.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { config } from '../config.js';
import { log } from '../log.js';
import { pool } from '../db/pool.js';
import { loadSession, login, logout, requireLogin, requireRole, checkCsrf, requireJsonBody, loginThrottle, recordFailedLogin } from './auth.js';
import { dashboardData, parseRange, BadRangeError } from './dashboard.js';
import { internalData, requestSync } from './internal.js';
import * as fmt from './format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(here, 'views'));
app.disable('x-powered-by');
app.locals.fmt = fmt;

app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    // No inline scripts anywhere; the pages work without JavaScript.
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(loadSession);

// ---------- auth ----------
app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.render('login', { error: null, username: '' })));
app.post('/login', loginThrottle, async (req, res) => {
  const username = String(req.body.username ?? '').trim();
  const user = await login(res, username, String(req.body.password ?? ''));
  if (!user) {
    recordFailedLogin(req);
    return res.status(401).render('login', { error: 'Wrong username or password.', username });
  }
  log.info('login', { username: user.username, role: user.role });
  res.redirect(user.role === 'admin' ? '/internal' : '/dashboard');
});
app.post('/logout', requireLogin, checkCsrf, async (req, res) => {
  await logout(req, res);
  res.redirect('/login');
});
app.get('/', requireLogin, (req, res) => res.redirect(req.user.role === 'admin' ? '/internal' : '/dashboard'));

// ---------- client page (client, and admin for support) ----------
/** Client: always their own shop. Admin: may pass ?shop=<id>, default the first shop. */
async function shopFor(req) {
  if (req.user.role === 'client') return req.user.shopId;
  if (req.query.shop) return String(req.query.shop);
  const [[s]] = await pool.query('SELECT id FROM shops ORDER BY connected_at LIMIT 1');
  return s?.id ?? null;
}

app.get('/dashboard', requireRole('client', 'admin'), async (req, res) => {
  const shopId = await shopFor(req);
  try {
    const data = await dashboardData(shopId, req.query.from, req.query.to);
    if (!data) return res.status(404).render('error', { title: 'No shop', message: 'This shop is not connected yet.' });
    res.render('dashboard', data);
  } catch (e) {
    if (e instanceof BadRangeError) {
      const data = await dashboardData(shopId);
      return res.status(400).render('dashboard', { ...data, rangeError: e.message });
    }
    throw e;
  }
});

app.get('/api/client/summary', requireRole('client', 'admin'), async (req, res) => {
  try {
    const data = await dashboardData(await shopFor(req), req.query.from, req.query.to);
    if (!data) return res.status(404).json({ error: 'shop not connected' });
    const { shop, from, to, summary, bridge, freshness, definition } = data;
    res.json({ shop: { id: shop.id, name: shop.name, timezone: shop.timezone }, from, to, definition, ...summary, bridge, last_synced_at: freshness?.last_success_at ?? null });
  } catch (e) {
    if (e instanceof BadRangeError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// ---------- internal page (admin only) ----------
app.get('/internal', requireRole('admin'), async (req, res) => {
  res.render('internal', { ...(await internalData()), flash: req.query.requested ? `Sync requested. The worker starts it within ${config.sync.tickMs / 1000} seconds.` : null });
});
app.post('/internal/shops/:id/sync', requireRole('admin'), checkCsrf, async (req, res) => {
  await requestSync(req.params.id, req.body.kind === 'full' ? 'full' : 'incremental');
  res.redirect('/internal?requested=1');
});

app.get('/api/internal/shops', requireRole('admin'), async (req, res) => res.json(await internalData()));
app.post('/api/internal/shops/:id/sync', requireRole('admin'), requireJsonBody, async (req, res) => {
  const found = await requestSync(req.params.id, req.body?.kind === 'full' ? 'full' : 'incremental');
  if (!found) return res.status(404).json({ error: 'unknown shop' });
  res.status(202).json({ requested: true });
});

// ---------- errors ----------
app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, _next) => {
  log.error('request failed', { path: req.path, error: err.message, stack: err.stack });
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'internal error' });
  res.status(500).render('error', { title: 'Something went wrong', message: 'The error has been logged.' });
});

export { app, parseRange };

// Run only when started directly (not when imported by tests). pathToFileURL makes this work on Windows too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(config.web.port, () => log.info(`web listening on http://localhost:${config.web.port}`));
}
