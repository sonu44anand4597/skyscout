import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import User from "../models/User.js";
import AuthSession from "../models/AuthSession.js";

const scrypt = promisify(scryptCallback);
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const COOKIE = "skyscout_session";

function setSessionCookie(res, token, maxAge = SESSION_MS / 1000) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const sameSite = process.env.SESSION_SAME_SITE || 'Lax';
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const sameSite = process.env.SESSION_SAME_SITE || 'Lax';
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`);
}

async function createSession(userId, res) {
  const token = randomBytes(32).toString("base64url");
  await AuthSession.create({ userId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + SESSION_MS) });
  setSessionCookie(res, token);
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = (stored || "").split(":");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const candidate = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function register(req, res, next) {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password;
  if (name.length < 2 || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== "string" || password.length < 10 || password.length > 128) {
    return res.status(400).json({ success: false, message: "Enter a valid name and email. Password must be 10–128 characters." });
  }
  try {
    const passwordHash = await hashPassword(password);
    const user = await User.create({ name, email, passwordHash });
    await createSession(user._id, res);
    return res.status(201).json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "An account with this email already exists." });
    return next(error);
  }
}

export async function login(req, res, next) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password;
  if (!email || typeof password !== "string" || password.length > 128) return res.status(400).json({ success: false, message: "Enter your email and password." });
  try {
    const user = await User.findOne({ email }).select("+passwordHash");
    if (!user || !(await verifyPassword(password, user.passwordHash))) return res.status(401).json({ success: false, message: "Email or password is incorrect." });
    await createSession(user._id, res);
    return res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    return next(error);
  }
}

export async function currentUser(req, res, next) {
  try {
    const user = await User.findById(req.userId).select("name email").lean();
    if (!user) return res.status(401).json({ success: false, message: "Account not found." });
    return res.json({ success: true, user: { id: String(user._id), name: user.name, email: user.email } });
  } catch (error) { return next(error); }
}

export async function logout(req, res, next) {
  try {
    const token = Object.fromEntries((req.headers.cookie || "").split(";").map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([name, value]) => name && value)).skyscout_session;
    // Possession of the opaque token authorizes revocation, even after expiry.
    // Do not require a live session to clear an expired/revoked browser cookie.
    if (/^[A-Za-z0-9_-]{43}$/.test(token || '')) await AuthSession.deleteOne({ tokenHash: createHash("sha256").update(token).digest("hex") });
    clearSessionCookie(res);
    return res.json({ success: true });
  } catch (error) { return next(error); }
}
