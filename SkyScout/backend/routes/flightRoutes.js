import express from "express";
import { getAirports, getFlightBookingOptions, getFlightReturnOptions, getFlights } from "../controllers/flightController.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

const router = express.Router();
const limitSearchCost = createRateLimiter({ limit: 30, scope: "flight-provider", message: "Too many flight searches. Wait a minute and try again." });

router.get("/search", limitSearchCost, getFlights);
router.get("/airports", createRateLimiter({ limit: 120, scope: 'airport-autocomplete', message: 'Too many airport searches. Wait a minute and try again.' }), getAirports);
router.post("/booking-options/:bookingRef", limitSearchCost, getFlightBookingOptions);
router.post("/return-options/:departureRef", limitSearchCost, getFlightReturnOptions);

export default router;
