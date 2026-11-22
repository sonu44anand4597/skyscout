import 'dotenv/config';
import connectDB, { closeDatabase } from './config/database.js';
import { validateRuntime } from './config/runtime.js';
import { createApp } from './app.js';
import { startMonitoringWorker, stopMonitoringWorker } from './services/monitoringWorker.js';

const { origins } = validateRuntime();
await connectDB();
const app = createApp({ origins });
const server = app.listen(process.env.PORT || 5000, async (error) => {
  if (error) {
    console.error(JSON.stringify({ event: 'api_start_failed', code: error.code || 'listen_error' }));
    await closeDatabase();
    process.exitCode = 1;
    return;
  }
  console.info(JSON.stringify({ event: 'api_started', port: Number(process.env.PORT || 5000), monitoring: process.env.MONITORING_ENABLED !== 'false' }));
  if (process.env.MONITORING_ENABLED !== 'false') startMonitoringWorker();
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  server.close(async () => { await stopMonitoringWorker(); await closeDatabase(); clearTimeout(deadline); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
