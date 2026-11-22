import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { createTrackedFlight, deleteTrackedFlight, flightDestinationIntelligence, flightFareIntelligence, flightFareMarket, flightHistory, flightPrediction, flightWeather, listNotifications, listTrackedFlights, markNotificationsRead, updateTrackedFlight } from "../controllers/trackedFlightController.js";
import { getTrackedFlight, refreshTrackedFlight } from '../controllers/trackedFlightController.js';

const router = express.Router();
const limitDestinationCost = createRateLimiter({ limit: 12, scope: "destination-intelligence", keyBy: 'user', message: "Too many destination updates. Wait a minute and try again." });
router.use(requireAuth);
router.get("/notifications", listNotifications);
router.patch("/notifications/read/all", markNotificationsRead);
router.patch("/notifications/read/:id", markNotificationsRead);
router.get("/", listTrackedFlights);
router.post("/", createTrackedFlight);
router.get("/:id/history", flightHistory);
router.get('/:id', getTrackedFlight);
router.get("/:id/fare-intelligence", flightFareIntelligence);
router.get("/:id/fare-intelligence/market", createRateLimiter({ limit: 12, scope: 'fare-market', keyBy: 'user' }), flightFareMarket);
router.post("/:id/fare-intelligence/research", createRateLimiter({ limit: 4, windowMs: 60 * 60 * 1000, scope: "fare-intelligence-research", keyBy: 'user', message: "Too many event research requests. Try again later." }), flightFareIntelligence);
router.get("/:id/prediction", flightPrediction);
router.get("/:id/weather", flightWeather);
router.get("/:id/destination-intelligence", limitDestinationCost, flightDestinationIntelligence);
router.patch("/:id", updateTrackedFlight);
router.post('/:id/refresh', createRateLimiter({ limit: 4, windowMs: 60 * 60 * 1000, scope: 'manual-fare-refresh', keyBy: 'user' }), refreshTrackedFlight);
router.delete("/:id", deleteTrackedFlight);

export default router;
