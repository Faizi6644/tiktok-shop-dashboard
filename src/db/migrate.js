/**
 * Applies SQL migrations in order (each exactly once, tracked in schema_migrations),
 * then seeds the two hardcoded users from the environment.
 * Usage: npm run migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { hashPassword } from '../web/passwords.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main() {
  // multipleStatements only for this one-off connection, never for the app pool.
  const conn = await mysql.createConnection({ uri: config.databaseUrl, multipleStatements: true });
  await conn.query("SET time_zone = '+00:00'");
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)))`);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const [done] = await conn.query('SELECT 1 FROM schema_migrations WHERE name = ?', [file]);
    if (done.length) continue;
    // Note: MySQL auto-commits DDL, so a migration cannot be rolled back as a unit.
    // Keep migrations small; a failed one must be fixed forward.
    await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    console.log(`applied ${file}`);
  }

  await seedUsers(conn);
  await conn.end();
}

async function seedUsers(conn) {
  const u = config.users;
  const shopId = config.tiktok.shopId;
  if (!u.clientPassword || !u.adminPassword || !shopId) {
    throw new Error('CLIENT_PASSWORD, ADMIN_PASSWORD and TTS_SHOP_ID must be set to seed users');
  }
  const upsert = `INSERT INTO users (username, password_hash, role, shop_id) VALUES (?,?,?,?) AS new
    ON DUPLICATE KEY UPDATE password_hash = new.password_hash, role = new.role, shop_id = new.shop_id`;
  await conn.query(upsert, [u.clientUsername, hashPassword(u.clientPassword), 'client', shopId]);
  await conn.query(upsert, [u.adminUsername, hashPassword(u.adminPassword), 'admin', null]);
  console.log(`seeded users: ${u.clientUsername} (client), ${u.adminUsername} (admin)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
