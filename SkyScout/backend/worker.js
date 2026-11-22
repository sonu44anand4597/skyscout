import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB, { closeDatabase } from './config/database.js';
import { runMonitoringTick, startMonitoringWorker, stopMonitoringWorker } from './services/monitoringWorker.js';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required for the monitoring worker.');
await connectDB();
if (mongoose.connection.readyState !== 1) { process.exitCode = 1; await closeDatabase(); }
else if (process.argv.includes('--once')) { await runMonitoringTick(); await closeDatabase(); }
else {
  startMonitoringWorker().ref();
  console.info(JSON.stringify({ event: 'monitoring_worker_started', intervalSeconds: 60, recheckHours: 6 }));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 15000); deadline.unref();
    await stopMonitoringWorker(); await closeDatabase(); clearTimeout(deadline);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
