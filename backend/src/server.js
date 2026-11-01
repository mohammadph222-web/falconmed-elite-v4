import { VERSION } from './lib/version.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { closeStaleTickets } from './services/queue.js';
import { refreshDemoIfStale } from './db/seed.js';

async function start() {
  // Applying pending migrations on boot keeps Render deploys one-step.
  // It never deletes data; seeding is a separate, explicit command.
  await migrate({ log: (m) => console.log(m) });

  // Close tickets left open from previous days and clear expired records, now and every 10 minutes.
  const housekeeping = () =>
    Promise.all([
      closeStaleTickets().then((r) => (r.abandoned || r.auto_closed) && console.log(`🧹 closed stale tickets`, r)),
      // Used or expired email links, and webhook IDs older than Stripe's retry window.
      pool.query(`DELETE FROM falconmed_v4.auth_tokens WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day'`),
      pool.query(`DELETE FROM falconmed_v4.stripe_events WHERE received_at < now() - interval '30 days'`),
      pool.query(`DELETE FROM falconmed_v4.rate_limits WHERE reset_at < now()`),
    ]).catch((err) => console.error('housekeeping failed:', err.message));
  await housekeeping();
  setInterval(housekeeping, 10 * 60 * 1000).unref();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`🚀 FalconMed Elite API v${VERSION} listening on :${env.PORT} (${env.NODE_ENV})`);
    // After listening, so a slow rebuild never delays the deploy health check.
    if (env.DEMO_AUTO_REFRESH) {
      refreshDemoIfStale().catch((err) => console.error('demo refresh failed:', err.message));
    }
  });

  const shutdown = (signal) => {
    console.log(`${signal} received — shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('❌ Failed to start:', err.message);
  process.exit(1);
});
