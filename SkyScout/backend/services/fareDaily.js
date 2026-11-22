import { buildFareBaseline, FARE_ENGINE_VERSION } from './fareBaseline.js';

export const ASSUMPTIONS = Object.freeze({
  normal: { label: 'Normal market', lower: -0.002, central: 0.001, upper: 0.004 },
  upward: { label: 'Upward pressure', lower: 0.001, central: 0.0045, upper: 0.008 },
  downward: { label: 'Downward pressure', lower: -0.008, central: -0.0045, upper: -0.001 },
});
const DAY = 86400000;
const shifted = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export function buildDailyFare(baseline, { mode = 'observed', market = 'normal', events = [] } = {}) {
  const maxDay = Math.min(14, Math.max(0, (baseline.daysUntilDeparture || 0) - 1));
  const assumption = ASSUMPTIONS[market] || ASSUMPTIONS.normal;
  const eligible = baseline.status !== 'unsupported_itinerary' && baseline.daysUntilDeparture > 0 && baseline.currentFare > 0;
  const points = [];
  if (eligible) for (let day = 0; day <= maxDay; day++) {
    const date = shifted(baseline.today, day);
    // Never extend a rate farther than its evidence supports.
    const enough = baseline.dailyRates && baseline.bookingDayCount >= (day <= 1 ? 3 : Math.max(7, day + 3)) && baseline.historySpanDays >= day * 2;
    const rates = mode === 'assumption' ? Object.fromEntries(Object.entries(assumption).filter(([key]) => key !== 'label').map(([key, value]) => [key, Math.log1p(value)])) : enough ? baseline.dailyRates : null;
    if (day && !rates) continue;
    const prices = Object.fromEntries(['lower', 'central', 'upper'].map((name) => [name, day ? Math.max(1, Math.round(baseline.currentFare * Math.exp(rates[name] * day))) : baseline.currentFare]));
    const change = prices.central - baseline.currentFare;
    const active = events.filter((event) => event.eventStart && event.eventStart <= date && (event.eventEnd || event.eventStart) >= date);
    points.push({ day, date, baselineFare: baseline.currentFare, ...prices, change, changePercent: Number((change / baseline.currentFare * 100).toFixed(2)),
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable', eventAdjustment: 0, eventIds: active.map((event) => event.id),
      evidence: day === 0 ? 'observed' : mode === 'assumption' ? 'assumption-based; not a validated forecast' : 'conditional observed trend; not a validated forecast',
      modelType: mode === 'assumption' ? 'conditional_hypothetical_scenario' : 'conditional_observed_trend', modelVersion: FARE_ENGINE_VERSION,
      calculation: { formula: 'round(baseline × exp(dailyLogRate × day)) + eventAdjustment', baseline: baseline.currentFare, dailyLogRates: day ? { lower: rates.lower, central: rates.central, upper: rates.upper } : { lower: 0, central: 0, upper: 0 }, day, eventAdjustment: 0, output: prices.central,
        baselineComponent: 0, combinedPercentage: Number((change / baseline.currentFare * 100).toFixed(2)),
        coefficientProvenance: mode === 'assumption' ? { classification: 'hypothetical_scenario_assumption', version: 'scenario-assumptions-v1', source: 'Application-configured rates in ASSUMPTIONS; chosen with the scenario controls. No quantitative empirical source or training is claimed.', input: market }
          : { classification: 'fitted_from_observed_itinerary_data', version: FARE_ENGINE_VERSION, source: 'Daily log changes from genuine, earlier PriceObservation records for this exact itinerary.', bookingDays: baseline.bookingDayCount, historySpanDays: baseline.historySpanDays },
        factors: [{ name: 'daily_log_change', input: day, coefficient: day ? rates.central : 0, contributionLogChange: day ? rates.central * day : 0, provenance: mode === 'assumption' ? 'hypothetical_scenario_assumption' : 'fitted_from_observed_itinerary_data' }, { name: 'news_and_calendar', input: active.length, coefficient: 0, contributionLogChange: 0, provenance: 'No independently quantified causal fare effect available.' }],
        explanation: `Baseline ${baseline.currentFare} + calculated movement ${change} + event adjustment 0 = ${prices.central}. Events are qualitative; no measured event-to-price effect is available.` },
    });
  }
  return { mode, market, maxDay, points, assumptions: ASSUMPTIONS, numericalEventPolicy: 'No independently quantified event effects: all event adjustments are zero.', limitation: 'Scenario bounds are not confidence intervals. No claim of predictive accuracy is made.' };
}

export function backtestFare(flight, observations) {
  const ordered = observations.filter((item) => Number.isFinite(item.price) && item.price > 0 && item.currency === flight.currency && Number.isFinite(new Date(item.observedAt).getTime())).sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: buildFareBaseline(flight, [], new Date()).timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dates = ordered.map((item) => dateFormat.format(new Date(item.observedAt)));
  const errors = [];
  const evaluated = new Set();
  for (let index = 3; index < ordered.length; index++) {
    if (dates[index] === dates[index - 1]) continue;
    const target = ordered[index];
    const cutoff = new Date(ordered[index - 1].observedAt);
    const baseline = buildFareBaseline(flight, ordered.slice(0, index), cutoff);
    const daily = buildDailyFare(baseline);
    const targetDate = new Intl.DateTimeFormat('en-CA', { timeZone: baseline.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(target.observedAt));
    const point = daily.points.find((item) => item.day > 0 && item.date === targetDate);
    if (!point || evaluated.has(targetDate)) continue;
    evaluated.add(targetDate);
    errors.push({ date: targetDate, predicted: point.central, actual: target.price, absoluteError: Math.abs(point.central - target.price), naiveError: Math.abs(baseline.currentFare - target.price) });
  }
  return { method: 'Expanding chronological holdout; only earlier quotes train each estimate; first observed quote on each target day evaluates it.', sampleCount: errors.length,
    mae: errors.length ? errors.reduce((sum, item) => sum + item.absoluteError, 0) / errors.length : null,
    naiveMae: errors.length ? errors.reduce((sum, item) => sum + item.naiveError, 0) / errors.length : null,
    mape: errors.length ? errors.reduce((sum, item) => sum + item.absoluteError / item.actual * 100, 0) / errors.length : null,
    evaluations: errors.slice(-10), status: errors.length >= 20 ? 'evaluated_limited_sample' : 'insufficient_evaluation', limitation: 'A small single-itinerary sample cannot establish general prediction accuracy.' };
}
