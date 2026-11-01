import { query } from '../config/db.js';

/**
 * express-rate-limit store kept in PostgreSQL, so limits hold across every API
 * instance and survive restarts. Used for the security-relevant limits (sign-in,
 * sign-up, email links); the general API ceiling stays in memory.
 */
export class PgStore {
  constructor(prefix) {
    this.prefix = `${prefix}:`;
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async get(key) {
    const { rows } = await query('SELECT hits, reset_at FROM falconmed_v4.rate_limits WHERE key = $1 AND reset_at > now()', [this.prefix + key]);
    return rows[0] ? { totalHits: rows[0].hits, resetTime: rows[0].reset_at } : undefined;
  }

  async increment(key) {
    // One statement: start a new window when the old one has passed, otherwise count the hit.
    const { rows } = await query(
      `INSERT INTO falconmed_v4.rate_limits AS r (key, hits, reset_at)
       VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE
          SET hits     = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
              reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
       RETURNING hits, reset_at`,
      [this.prefix + key, this.windowMs / 1000],
    );
    return { totalHits: rows[0].hits, resetTime: rows[0].reset_at };
  }

  async decrement(key) {
    await query('UPDATE falconmed_v4.rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [this.prefix + key]);
  }

  async resetKey(key) {
    await query('DELETE FROM falconmed_v4.rate_limits WHERE key = $1', [this.prefix + key]);
  }
}
