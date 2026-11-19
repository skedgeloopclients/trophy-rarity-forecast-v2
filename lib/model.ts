// Rate snapshots for a case arrive as a short timeline. The simplest guess is to
// reuse the newest percentage and widen it by a constant band. We do that, but
// we work in log-odds (so percentages near the edges behave nicely), we lean a
// little on the recent direction of travel, and we set the band width from how
// erratic the observed readings were. A calm trophy gets a slim interval; a
// choppy one gets a broad interval.

// The scoreboard scores the 5th, 25th, 50th, 75th and 95th percentiles.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// How far, in standard deviations, each of those levels sits from the centre.
const Z = [-1.644854, -0.674490, 0, 0.674490, 1.644854];

export interface Case {
  levels: number[];
  at: string;
  target: string;
  horizon_minutes: number;
  trophies: Array<{ id: number; tier?: string }>;
  history: Array<{ at: string; rates: Array<number | null> }>;
}

// Stay just inside the open interval so the log-odds transform is always finite.
const clamp = (pct: number): number => Math.min(99.99, Math.max(0.01, pct));
// Move from a percentage to log-odds space, where the forecasting math happens.
const logit = (pct: number): number => {
  const p = clamp(pct);
  return Math.log(p / (100 - p));
};
// Bring a log-odds value back to a percentage in the range 0..100.
const expit = (x: number): number => 100 / (1 + Math.exp(-x));

/** Compute five rate quantiles for each trophy at the case's target time. */
export function forecast(c: Case): { id: number; q: number[] }[] {
  const n = c.trophies.length;
  // A snapshot is only usable when it has one rate slot per trophy.
  const reads = c.history.filter((h) => h.rates && h.rates.length === n);
  // Horizon measured in days; keep a one-minute floor to avoid degenerate math.
  const d = Math.max(1 / 1440, c.horizon_minutes / 1440);

  return c.trophies.map((t, i) => {
    // Scan from newest to oldest for the last snapshot that actually carries a
    // value for this trophy, and treat that reading as our anchor.
    let li = -1;
    for (let k = reads.length - 1; k >= 0; k--) {
      if (reads[k].rates[i] !== null) { li = k; break; }
    }
    const lastRate = li >= 0 ? clamp(reads[li].rates[i]!) : 0.5;
    const anchor = logit(lastRate);

    // Estimate a slope in log-odds from the anchor back two usable snapshots.
    // Cap it, take half, and stretch it across the horizon: a cautious drift.
    let slope = 0;
    if (li >= 2) {
      const endT = Date.parse(reads[li].at);
      const startT = Date.parse(reads[li - 2].at);
      const spanDays = (endT - startT) / 86400000;
      if (spanDays > 0) {
        const earlier = logit(reads[li - 2].rates[i] ?? lastRate);
        slope = (anchor - earlier) / spanDays;
      }
    }
    const drift = Math.max(-1.5, Math.min(1.5, slope)) * d * 0.5;

    // Volatility is the root-mean-square deviation of the last few valid logit
    // readings around the anchor. More scatter means a wider predictive band.
    let sumSq = 0, seen = 0;
    for (let k = Math.max(0, li - 4); k <= li; k++) {
      const v = reads[k].rates[i];
      if (v === null) continue;
      const lv = logit(v);
      sumSq += (lv - anchor) * (lv - anchor);
      seen++;
    }
    const observed = seen > 1 ? Math.sqrt(sumSq / seen) : 0;

    // Blend a minimum floor with measured movement, then cap at the house scale.
    const sigma = Math.max(
      0.08 * Math.sqrt(d),
      Math.min(0.5 * Math.sqrt(d), observed * 1.2 + 0.10 * Math.sqrt(d)),
    );

    // Shift the centre by the drift, then push each z-score through the logistic and keep four decimals.
    const mu = anchor + drift;
    const q = LEVELS.map((_, j) => Math.round(expit(mu + Z[j] * sigma) * 10000) / 10000);
    // Guard against crossings by lifting any value that fell below its neighbour.
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { id: t.id, q };
  });
}
