// A case gives us several timestamped snapshots of how often each trophy has
// been cleared. Raw percentages are awkward to extrapolate: they get squeezed
// near 0 and 100. So every calculation happens in log-odds space, where upward
// and downward pushes are symmetric, and only at the very end do we convert
// back to a percentage. The forecast centre begins at the newest reliable
// reading, is nudged by a tamed recent slope, and gets a small launch boost.
// The band around it widens both with elapsed time and with recent volatility.

// Which percentiles the harness scores: 5th, 25th, median, 75th, 95th.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Matching standard-normal quantiles (z-scores) for those five percentiles.
const Z = [-1.644854, -0.674490, 0, 0.674490, 1.644854];

// The shape of one input case and of each history entry it contains.
export interface Case {
  levels: number[];
  at: string;
  target: string;
  horizon_minutes: number;
  trophies: Array<{ id: number; tier?: string }>;
  history: Array<{ at: string; rates: Array<number | null> }>;
}

// Pull a percentage just inside the open (0, 100) interval so the log-odds
// math never divides by zero or takes the log of zero.
const clampPct = (pct: number): number => Math.min(99.99, Math.max(0.01, pct));

// Percent -> log-odds. This is the space in which we do all extrapolation.
const logit = (pct: number): number => {
  const p = clampPct(pct);
  return Math.log(p / (100 - p));
};

// Log-odds -> percent (the logistic / expit inverse of the step above).
const expit = (z: number): number => 100 / (1 + Math.exp(-z));

/**
 * Return one row per trophy: its id plus five quantile estimates in percent,
 * each valid at the case's target time.
 */
export function forecast(c: Case): { id: number; q: number[] }[] {
  const total = c.trophies.length;
  // Ignore malformed snapshots that do not carry a slot for every trophy.
  const reads = c.history.filter((h) => h.rates && h.rates.length === total);
  // Convert the horizon to days; the one-minute floor keeps the spread positive
// even when the forecast targets a time only moments from now.
  const days = Math.max(1 / 1440, c.horizon_minutes / 1440);

  return c.trophies.map((trophy, idx) => {
    // Scan backwards for the most recent snapshot with an actual number for
    // this trophy; holes in the history are simply passed over.
    let newest = -1;
    for (let k = reads.length - 1; k >= 0; k--) {
      if (reads[k].rates[idx] !== null) {
        newest = k;
        break;
      }
    }

    // Anchor the centre at that last known rate, defaulting to a neutral 0.5%.
    const lastPct = newest >= 0 ? clampPct(reads[newest].rates[idx]!) : 0.5;
    const anchor = logit(lastPct);

    // Estimate direction from the reading two snapshots back. Halve it and cap
    // the daily slope so one noisy stretch cannot yank the centre too far.
    let slope = 0;
    if (newest >= 2) {
      const endMs = Date.parse(reads[newest].at);
      const startMs = Date.parse(reads[newest - 2].at);
      const spanDays = (endMs - startMs) / 86400000;
      if (spanDays > 0) {
        const earlier = logit(reads[newest - 2].rates[idx] ?? lastPct);
        slope = (anchor - earlier) / spanDays;
      }
    }
    const boundedSlope = Math.max(-1.5, Math.min(1.5, slope));
    // Project the tamed slope over the horizon, then damp it by half again.
    const trendPush = boundedSlope * days * 0.5;

    // Volatility is the spread of the last few valid log-odds around the
    // anchor; a jumpy trophy deserves a wider predictive interval.
    let squared = 0;
    let seen = 0;
    for (let k = Math.max(0, newest - 4); k <= newest; k++) {
      const value = reads[k].rates[idx];
      if (value === null) continue;
      squared += (logit(value) - anchor) ** 2;
      seen++;
    }
    const observed = seen > 1 ? Math.sqrt(squared / seen) : 0;

    // The proven house baseline is 0.5 per square-root-day. Treat it as a hard
    // floor, never a ceiling: a flat history must not produce an overconfident
    // narrow band, which scores far worse than the validated baseline spread.
    const baseline = 0.5 * Math.sqrt(days);
    const sigma = Math.max(baseline, observed * 0.6 + baseline);

    // Trophies keep getting earned as a title settles in, so give the centre a
    // gentle horizon-scaled upward lift instead of assuming a flat future.
    const launchPush = 0.35 * days;
    const center = anchor + trendPush + launchPush;

    // Place each z-score around the centre and map back to four-decimal percents.
    const q = LEVELS.map((_, j) =>
      Math.round(expit(center + Z[j] * sigma) * 10000) / 10000,
    );
    // Rounding can occasionally flip a neighbouring pair, so enforce a sorted
    // curve and then clip every value into the allowed output range.
    for (let j = 1; j < q.length; j++) {
      if (q[j] < q[j - 1]) q[j] = q[j - 1];
    }
    for (let j = 0; j < q.length; j++) {
      q[j] = clampPct(q[j]);
    }
    return { id: trophy.id, q };
  });
}
