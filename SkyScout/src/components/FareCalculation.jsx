import { formatFare, formatSignedFare, formatSignedPercent } from '../utils/fareScenario.js';

export default function FareCalculation({ selected, baseline, evaluation, horizon, currency }) {
  const calculation = selected?.calculation;
  return <details className="mt-5 border-t border-slate-200 pt-4 text-xs text-slate-600">
    <summary className="cursor-pointer font-semibold text-violet-700">Why this estimate?</summary>
    {!calculation ? <p className="mt-3">A verified reference fare is needed for a calculation.</p> : <div className="mt-3 space-y-3">
      <p>Reference fare {formatFare(calculation.baseline, currency)} · <a className="text-violet-700 underline" href="https://serpapi.com/google-flights-api" target="_blank" rel="noopener noreferrer">SerpApi Google Flights</a> · observed {baseline?.currentObservation?.observedAt ? new Date(baseline.currentObservation.observedAt).toLocaleString('en-IN') : 'timestamp unavailable'}{baseline?.currentObservation?.stale ? ' · stale quote' : ''}.</p>
      <p>{baseline?.daysUntilDeparture} calendar days until departure · {horizon}-day view · selected Day {selected.day}, {selected.date} · calculation timezone {baseline?.timezone}.</p>
      <p className="font-semibold">{calculation.formula}</p>
      <p>Daily log rates: lower {calculation.dailyLogRates.lower}, central {calculation.dailyLogRates.central}, upper {calculation.dailyLogRates.upper}. Baseline component {calculation.baselineComponent || 0}; event adjustment {calculation.eventAdjustment}.</p>
      <div className="overflow-x-auto"><table className="w-full text-left"><caption className="mb-2 text-left font-semibold">Market-factor breakdown</caption><thead><tr><th className="p-2">Factor</th><th className="p-2">Input</th><th className="p-2">Coefficient</th><th className="p-2">Log contribution</th></tr></thead><tbody>{calculation.factors?.map((factor) => <tr key={factor.name}><td className="p-2">{factor.name === 'daily_log_change' ? 'Daily fare movement' : 'News and calendar'}</td><td className="p-2">{factor.input}</td><td className="p-2">{factor.coefficient}</td><td className="p-2">{factor.contributionLogChange}</td></tr>)}</tbody></table></div>
      <p>{calculation.coefficientProvenance?.source} Coefficient classification: {calculation.coefficientProvenance?.classification?.replaceAll('_', ' ')}. Version {calculation.coefficientProvenance?.version}.</p>
      {selected.modelType === 'conditional_observed_trend' && baseline?.dailyRates?.bound && <p>{baseline.dailyRates.bound}</p>}
      <p>Central fare {formatFare(calculation.output, currency)} = reference {formatFare(calculation.baseline, currency)} + {formatSignedFare(selected.change, currency)}. Percentage = 100 × {selected.change} / {calculation.baseline} = {formatSignedPercent(selected.changePercent)} (rounded to two decimals).</p>
      <p>Model {selected.modelVersion || baseline?.version} · {selected.modelType?.replaceAll('_', ' ')}. Ranges are scenarios, not confidence intervals. News has no independently quantified contribution.</p>
      <p>Chronological evaluation: {evaluation?.sampleCount || 0} eligible holdouts. {evaluation?.mae != null ? `MAE ${formatFare(evaluation.mae, currency)}, MAPE ${evaluation.mape.toFixed(2)}%; last-price baseline MAE ${formatFare(evaluation.naiveMae, currency)}.` : 'Not enough genuine history to measure forecast error.'} {evaluation?.limitation}</p>
    </div>}
  </details>;
}
