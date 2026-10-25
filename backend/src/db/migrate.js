import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../config/db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply every .sql file in migrations/ once, in name order. Safe to re-run. */
export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    // Safety: never build on top of a same-named schema created by another project.
    const { rows: foreign } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'falconmed_v4'
          AND table_name NOT IN ('branches', 'users', 'tickets', 'ticket_metrics', 'schema_migrations')`,
    );
    if (foreign.length) {
      throw new Error(
        `Schema "falconmed_v4" already contains tables from another project (${foreign.map((r) => r.table_name).join(', ')}). ` +
          'Nothing was changed.',
      );
    }
    await client.query('CREATE SCHEMA IF NOT EXISTS falconmed_v4');
    await client.query(`CREATE TABLE IF NOT EXISTS falconmed_v4.schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT name FROM falconmed_v4.schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO falconmed_v4.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`✅ applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    log('✅ database schema is up to date');
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error('❌', err.message);
      process.exit(1);
    });
}
