import { env } from './config/env.js';
import { pool } from './config/db.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { closeStaleTickets } from './services/queue.js';

async function start() {
  // Applying pending migrations on boot keeps Render deploys one-step.
  // It never deletes data; seeding is a separate, explicit command.
  await migrate({ log: (m) => console.log(m) });

  // Close tickets left open from previous days, now and every 10 minutes.
  const housekeeping = () =>
    closeStaleTickets()
      .then((r) => (r.abandoned || r.auto_closed) && console.log(`🧹 closed stale tickets`, r))
      .catch((err) => console.error('housekeeping failed:', err.message));
  await housekeeping();
  setInterval(housekeeping, 10 * 60 * 1000).unref();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`🚀 FalconMed Elite API v4.2 listening on :${env.PORT} (${env.NODE_ENV})`);
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
