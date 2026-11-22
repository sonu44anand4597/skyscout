import mongoose from "mongoose";
import dns from "node:dns";
import { createDatabaseLookup } from './databaseLookup.js';

let retryTimer;
let retryAt;
let retryAttempt = 0;
let connecting = false;
let shuttingDown = false;
const databaseLookup = createDatabaseLookup();

function scheduleReconnect() {
  if (shuttingDown || !process.env.MONGODB_URI || retryTimer || connecting) return;
  const delay = Math.min(5000 * (2 ** retryAttempt), 5 * 60 * 1000);
  retryAt = Date.now() + delay;
  retryAttempt = Math.min(retryAttempt + 1, 6);
  console.warn(`MongoDB reconnect scheduled in ${Math.round(delay / 1000)} seconds.`);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    retryAt = undefined;
    connectDB();
  }, delay);
  retryTimer.unref?.();
}

mongoose.connection.on("disconnected", scheduleReconnect);

export function getDatabaseHealth() {
  const state = !process.env.MONGODB_URI ? "unconfigured"
    : mongoose.connection.readyState === 1 ? "connected"
      : retryTimer ? "retrying"
        : mongoose.connection.readyState === 2 ? "connecting" : "disconnected";
  return { state, retryInSeconds: retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : null };
}

const connectDB = async () => {
  if (shuttingDown) return null;
  mongoose.set("bufferCommands", false);
  const dnsServers = process.env.DNS_SERVERS
    ?.split(",")
    .map((server) => server.trim())
    .filter(Boolean);

  if (dnsServers?.length) {
    dns.setServers(dnsServers);
  }

  if (!process.env.MONGODB_URI) {
    console.warn("MongoDB is not configured; continuing without database features.");
    return null;
  }

  if (connecting || mongoose.connection.readyState === 1) return mongoose.connection;

  connecting = true;
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, { lookup: databaseLookup, serverSelectionTimeoutMS: 12000 });
    retryAttempt = 0;

    console.log(
      `✅ MongoDB Connected: ${conn.connection.host}`
    );
  } catch (error) {
    console.error(
      "❌ MongoDB Connection Failed"
    );

    console.error(JSON.stringify({ event: 'database_connection_failed', category: error.name || 'connection_error', code: error.code || null }));

    // Flight search is backed by SerpApi and must remain available when the
    // optional database is temporarily unavailable.
    return null;
  } finally {
    connecting = false;
    if (mongoose.connection.readyState !== 1) scheduleReconnect();
  }
};

export async function closeDatabase() {
  shuttingDown = true;
  clearTimeout(retryTimer);
  retryTimer = undefined; retryAt = undefined;
  await mongoose.disconnect();
}

export default connectDB;
