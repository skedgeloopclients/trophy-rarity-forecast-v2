// Each case carries a handful of dated snapshots of trophy clearance rates.
// The forecast works in log-odds rather than raw percentages: a rate near 0 or
// 100 can then drift symmetrically and be mapped back without leaving the
// (0, 100) interval. The centre is the most recent trustworthy reading, nudged
// forward by a damped recent trend. Uncertainty grows with the time horizon and
// with how much the recent readings bounced around that centre.

// The evaluation looks at the 5th, 25th, median, 75th and 95th percentiles.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard-normal cut points matched one-for-one with the levels above.
const Z = [-1.644854, -0.674490, 0, 0.674490, 1.644854];

export interface Case {
  levels: number[];
  at: string;
  target: string;
  horizon_minutes: number;
  trophies: Array<{ id: number; tier?: string }>;
  history: Array<{ at: string; rates: Array<number | null> }>;
}

// Clamp to a hair inside [0, 100] so the log-odds transform stays finite.
const bound = (pct: number): number => Math.min(99.99, Math.max(0.01, pct));
// Percentage -> log-odds: the space where all the extrapolation happens.
const toLogit = (pct: number): number => {
  const p = bound(pct);
  return Math.log(p / (100 - p));
};
// Log-odds -> percentage, always landing back in the open unit interval.
const fromLogit = (z: number): number => 100 / (1 + Math.exp(-z));

/**
 * Produce five quantile estimates for every trophy in a case, valid at the
 * case's target timestamp.
 */
export function forecast(c: Case): { id: number; q: number[] }[] {
  const trophyCount = c.trophies.length;
  // A snapshot is trustworthy only if it has a slot for every trophy.
  const snapshots = c.history.filter((h) => h.rates && h.rates.length === trophyCount);
  // Work in days, with a tiny floor so a near-zero horizon stays well-defined.
  const days = Math.max(1 / 1440, c.horizon_minutes / 1440);

  return c.trophies.map((trophy, idx) => {
    // Walk newest-to-oldest to find the latest snapshot that actually has a
    // number for this trophy; missing readings are simply skipped.
    let latest = -1;
    for (let k = snapshots.length - 1; k >= 0; k--) {
      if (snapshots[k].rates[idx] !== null) {
        latest = k;
        break;
      }
    }

    // Carry the last known percentage into log-odds as our anchor point.
    const lastRate = latest >= 0 ? bound(snapshots[latest].rates[idx]!) : 0.5;
    const anchor = toLogit(lastRate);

    // Read the recent direction of travel from two snapshots back. Shrink it by
    // half and cap its magnitude so a single noisy stretch cannot dominate.
    let trend = 0;
    if (latest >= 2) {
      const endMs = Date.parse(snapshots[latest].at);
      const startMs = Date.parse(snapshots[latest - 2].at);
      const spanDays = (endMs - startMs) / 86400000;
      if (spanDays > 0) {
        const earlier = toLogit(snapshots[latest - 2].rates[idx] ?? lastRate);
        trend = (anchor - earlier) / spanDays;
      }
    }
    const capped = Math.max(-1.5, Math.min(1.5, trend));
    const drift = capped * days * 0.5;

    // Volatility: scatter of the last few valid log-odds readings about the
    // anchor. A jumpy trophy earns a wider predictive band.
    let sqSum = 0;
    let valid = 0;
    for (let k = Math.max(0, latest - 4); k <= latest; k++) {
      const value = snapshots[k].rates[idx];
      if (value === null) continue;
      const lv = toLogit(value);
      sqSum += (lv - anchor) ** 2;
      valid++;
    }
    const observed = valid > 1 ? Math.sqrt(sqSum / valid) : 0;

    // Floor the spread at a horizon-scaled minimum and ceiling it at the house
    // limit, blending in the measured scatter in between.
    const sigma = Math.max(
      0.08 * Math.sqrt(days),
      Math.min(0.5 * Math.sqrt(days), observed * 1.2 + 0.10 * Math.sqrt(days)),
    );

    // Shift the centre by the drift, push each z-score through the logistic,
    // and keep a clean four-decimal rounding.
    const center = anchor + drift;
    const q = LEVELS.map((_, j) =>
      Math.round(fromLogit(center + Z[j] * sigma) * 10000) / 10000,
    );
    // Rounding can (rarely) invert neighbours; force a monotone curve and clip
    // once more into the permitted output range.
    for (let j = 1; j < q.length; j++) {
      if (q[j] < q[j - 1]) q[j] = q[j - 1];
    }
    for (let j = 0; j < q.length; j++) {
      q[j] = bound(q[j]);
    }
    return { id: trophy.id, q };
  });
}
