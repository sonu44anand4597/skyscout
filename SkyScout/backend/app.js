import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { getDatabaseHealth } from './config/database.js';
import { allowedOrigins } from './config/runtime.js';
import securityHeaders from './middleware/securityHeaders.js';
import { protectMutations } from './middleware/csrf.js';
import flightRoutes from './routes/flightRoutes.js';
import authRoutes from './routes/authRoutes.js';
import trackedFlightRoutes from './routes/trackedFlightRoutes.js';
import { operationSnapshot, requireOperationsToken } from './services/operations.js';

export function createApp({ origins = allowedOrigins(), databaseHealth = getDatabaseHealth } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.use(securityHeaders);
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || origins.includes(origin)), credentials: true,
    allowedHeaders: ['Content-Type', 'X-SkyScout-Request', 'Authorization'], exposedHeaders: ['X-Request-Id', 'Retry-After'] }));
  app.use(protectMutations(origins));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.get('/', (req, res) => res.json({ success: true, message: 'SkyScout Backend Running' }));
  app.get('/health', (req, res) => {
    const database = databaseHealth();
    res.json({ success: true, status: database.state === 'connected' ? 'ok' : 'degraded', uptimeSeconds: Math.floor(process.uptime()),
      services: { database: database.state, databaseRetryInSeconds: database.retryInSeconds, flightSearch: process.env.SERPAPI_API_KEY ? 'configured' : 'unconfigured' } });
  });
  app.get('/readyz', async (req, res) => {
    let ready = databaseHealth().state === 'connected';
    if (ready) {
      try { await mongoose.connection.db.command({ ping: 1 }, { timeoutMS: 2000 }); }
      catch { ready = false; }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({ success: ready, status: ready ? 'ready' : 'not_ready' });
  });
  app.get('/api/operations', requireOperationsToken, async (req, res, next) => {
    try {
      let ml = { status: 'offline' };
      try {
        const response = await fetch(`${process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001'}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) { const data = await response.json(); ml = { status: data.available ? 'available' : 'no_validated_model', regions: data.regions }; }
      } catch { /* ML remains optional. */ }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, database: databaseHealth(), operations: await operationSnapshot(), ml });
    } catch (error) { next(error); }
  });
  app.use('/api/flights', flightRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/tracked-flights', trackedFlightRoutes);
  app.use((req, res) => res.status(404).json({ success: false, message: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' || error.name === 'ValidationError' ? 400 : 503;
    console.error(JSON.stringify({ event: 'request_failed', requestId: req.requestId, category: error.type || error.name || 'internal', status }));
    return res.status(status).json({ success: false, requestId: req.requestId, message: status === 413 ? 'Request body is too large.' : status === 400 ? 'Enter a valid JSON request with supported values.' : 'The service is temporarily unavailable. Please try again.' });
  });
  return app;
}
