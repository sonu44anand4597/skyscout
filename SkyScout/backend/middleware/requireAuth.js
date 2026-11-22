import { createHash } from "node:crypto";
import AuthSession from "../models/AuthSession.js";

export default async function requireAuth(req, res, next) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([name, value]) => name && value));
  const token = cookies.skyscout_session;
  if (!token) return res.status(401).json({ success: false, message: "Please sign in to continue." });

  try {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = await AuthSession.findOne({ tokenHash, expiresAt: { $gt: new Date() } }).select("userId").lean();
    if (!session) return res.status(401).json({ success: false, message: "Your session has expired. Please sign in again." });
    req.userId = session.userId;
    return next();
  } catch (error) {
    return next(error);
  }
}
