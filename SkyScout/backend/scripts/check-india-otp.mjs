import { getIndianOperationalContext } from "../services/indiaOperationalContext.js";

const context = await getIndianOperationalContext("IndiGo", "6E 123");
if (!context || context.usedInPrediction !== false || !Number.isFinite(context.otpPercent)) {
  throw new Error("Official Indian aggregate OTP context was unavailable or malformed.");
}
console.log(JSON.stringify({ result: "passed", airline: context.airlineCode, otpPercent: context.otpPercent, reportedDate: context.reportedDate, usedInPrediction: context.usedInPrediction, sourceUrl: context.sourceUrl }));
