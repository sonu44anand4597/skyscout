import { createHash } from "node:crypto";
import mongoose from "mongoose";
import RateLimitBucket from "../models/RateLimitBucket.js";
import { persistOperation } from '../services/operations.js';
import { logServiceError } from '../services/safeLogging.js';

export function createRateLimiter({ limit, windowMs = 60_000, message, maxBuckets = 10_000, scope = "api", keyBy = 'ip' }) {
  const buckets = new Map();
  async function reject(res, expiresAt, now) {
    await persistOperation('rate_limit', 'limited', { scope }).catch(() => {});
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((expiresAt - now) / 1000))));
    return res.status(429).json({ success: false, message: message || 'Too many requests. Try again later.' });
  }

  return async function rateLimit(req, res, next) {
    const now = Date.now();
    const key = keyBy === 'user' && req.userId ? `user:${req.userId}` : req.ip || "unknown";
    if (mongoose.connection.readyState === 1) {
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const digest = createHash("sha256").update(`${scope}:${key}`).digest("hex");
      const id = `${digest}:${windowStart}`;
      const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs) } };
      try {
        let bucket;
        try {
          bucket = await RateLimitBucket.findOneAndUpdate({ _id: id }, update, { upsert: true, returnDocument: "after" }).lean();
        } catch (error) {
          if (error.code !== 11000) throw error;
          bucket = await RateLimitBucket.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { returnDocument: "after" }).lean();
        }
        if (bucket.count > limit) return reject(res, windowStart + windowMs, now);
        return next();
      } catch (error) {
        logServiceError('rate_limit_storage_failed', error);
        return res.status(503).json({ success: false, message: "The service is temporarily unavailable. Please try again." });
      }
    }
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      if (bucket) buckets.delete(key);
      if (buckets.size >= maxBuckets) {
        for (const [address, current] of buckets) {
          if (now - current.start >= windowMs) buckets.delete(address);
        }
        while (buckets.size >= maxBuckets) buckets.delete(buckets.keys().next().value);
      }
      bucket = { start: now, count: 0 };
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > limit) return reject(res, bucket.start + windowMs, now);
    return next();
  };
}
