import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * AES-256-GCM encryption for OAuth tokens at rest. A database dump or backup alone does not
 * leak usable tokens: you also need TOKEN_ENCRYPTION_KEY, which only the worker has
 * (in production it would come from a secrets manager / KMS).
 * Stored format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>
 */
function key() {
  const raw = config.tokenEncryptionKey;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return buf;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(box) {
  const [v, iv, tag, ct] = String(box).split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unrecognised token ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
