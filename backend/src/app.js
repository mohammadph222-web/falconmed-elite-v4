import { VERSION } from './lib/version.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { errorHandler, notFound } from './lib/http.js';
import authRoutes from './routes/auth.js';
import metricsRoutes from './routes/metrics.js';
import queueRoutes from './routes/queue.js';
import branchRoutes from './routes/branches.js';
import importRoutes from './routes/imports.js';
import orgRoutes from './routes/org.js';
import billingRoutes, { webhookRouter } from './routes/billing.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render's proxy: correct client IP for rate limiting
  app.disable('x-powered-by');

  // Every response carries an ID that also appears in the server log, for support requests.
  app.use((req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(helmet());
  app.use(compression());
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin / server-to-server requests (curl, queue machine) send no Origin.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        // Preview deployments, only when a pattern is configured (CORS_PREVIEW_PATTERN).
        if (env.corsPreview?.test(origin)) return cb(null, true);
        cb(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Queue-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
      maxAge: 86400,
    }),
  );
  // Stripe signs the raw bytes, so the webhook reads its own body before any JSON parsing.
  app.use('/api/billing/webhook', webhookRouter);

  // A ceiling for every client, well above what a busy counter or dashboard needs.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => env.NODE_ENV === 'test',
      message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again in a minute.' } },
    }),
  );
  // API responses hold private data: never store them in shared or browser caches.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Small bodies everywhere, except CSV uploads to the importer.
  const smallJson = express.json({ limit: '50kb' });
  const uploadJson = express.json({ limit: '9mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/imports') ? uploadJson : smallJson)(req, res, next));

  app.get('/', (req, res) => {
    res.json({ name: 'FalconMed Elite API', version: VERSION, docs: '/api/health' });
  });

  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ success: true, status: 'ok', database: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ success: false, status: 'degraded', database: 'down' });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/metrics', metricsRoutes);
  app.use('/api/queue', queueRoutes);
  app.use('/api/branches', branchRoutes);
  app.use('/api/imports', importRoutes);
  app.use('/api/org', orgRoutes);
  app.use('/api/billing', billingRoutes);

  app.use((req, res, next) => next(notFound(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler(env.isProd));
  return app;
}
