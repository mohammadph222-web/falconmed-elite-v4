import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { errorHandler, notFound } from './lib/http.js';
import authRoutes from './routes/auth.js';
import metricsRoutes from './routes/metrics.js';
import queueRoutes from './routes/queue.js';
import branchRoutes from './routes/branches.js';
import importRoutes from './routes/imports.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render's proxy: correct client IP for rate limiting
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(compression());
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin / server-to-server requests (curl, queue machine) send no Origin.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        // Vercel preview deployments of this project.
        if (/^https:\/\/falconmed-[a-z0-9-]+\.vercel\.app$/.test(origin)) return cb(null, true);
        cb(null, false);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Queue-Key'],
      maxAge: 86400,
    }),
  );
  // Small bodies everywhere, except CSV uploads to the importer.
  const smallJson = express.json({ limit: '50kb' });
  const uploadJson = express.json({ limit: '9mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/imports') ? uploadJson : smallJson)(req, res, next));

  app.get('/', (req, res) => {
    res.json({ name: 'FalconMed Elite API', version: '4.3.0', docs: '/api/health' });
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

  app.use((req, res, next) => next(notFound(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler(env.isProd));
  return app;
}
