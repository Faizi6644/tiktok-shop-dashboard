import mysql from 'mysql2/promise';
import { config } from '../config.js';

/**
 * - DECIMAL columns come back as strings. We keep them as strings on purpose: money is summed
 *   in SQL and only formatted for display, never added up as JavaScript floats.
 * - Every connection runs in UTC so DATETIME values mean the same thing everywhere.
 */
export const pool = mysql.createPool({
  uri: config.databaseUrl,
  connectionLimit: 10,
  timezone: 'Z',
  decimalNumbers: false,
  dateStrings: false,
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Run fn inside a transaction on one connection; commit on success, roll back on error. */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}
