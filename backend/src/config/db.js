import pg from 'pg';
import { env } from './env.js';

// Return NUMERIC and BIGINT as JS numbers (values here are small counts/minutes).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// Return DATE as a plain 'YYYY-MM-DD' string (avoid timezone shifts).
pg.types.setTypeParser(1082, (v) => v);

function sslConfig() {
  if (env.DB_SSL === 'off') return false;
  if (env.DB_SSL === 'on') return { rejectUnauthorized: true };
  const local = /@(localhost|127\.0\.0\.1)|host=\/|%2F/.test(env.DATABASE_URL);
  return local ? false : { rejectUnauthorized: true };
}

// TLS is configured explicitly below, so drop sslmode / channel_binding from the
// URL. This also silences pg's "SSL modes are treated as aliases" warning.
function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    ['sslmode', 'channel_binding', 'uselibpqcompat'].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return raw;
  }
}

export const pool = new pg.Pool({
  connectionString: cleanUrl(env.DATABASE_URL),
  ssl: sslConfig(),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

// Note: Neon's pooled endpoint (PgBouncer, transaction mode) does not keep
// session settings, so no SET search_path / SET TIME ZONE here. Every query
// schema-qualifies its tables (falconmed_v4.*) and converts time zones explicitly.

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

export const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
