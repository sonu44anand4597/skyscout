const DAY_MS = 86_400_000;

export function daysBeforeDeparture(today, departureDate) {
  const start = Date.parse(`${today}T00:00:00Z`);
  const end = Date.parse(`${departureDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / DAY_MS) - 1);
}

export function formatFare(value, currency = "INR") {
  if (!Number.isFinite(value) || !/^[A-Z]{3}$/.test(currency || "")) return "Unavailable";
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value); }
  catch { return `${currency} ${Math.round(value).toLocaleString("en-IN")}`; }
}

export function formatSignedFare(value, currency = "INR") {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatFare(Math.abs(value), currency)}`;
}

export function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2).replace(/0$/, '')}%`;
}

