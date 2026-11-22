import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { currentUser, login, logout, register } from "../controllers/authController.js";

const router = express.Router();
const authRateLimit = createRateLimiter({ limit: 10, scope: "auth", message: "Too many sign-in attempts. Wait a minute and try again." });

router.post("/register", authRateLimit, register);
router.post("/login", authRateLimit, login);
router.get("/me", requireAuth, currentUser);
router.post("/logout", logout);

export default router;
