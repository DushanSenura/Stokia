export interface BarInput { key: string; amount: number | null }
export interface Bar { key: string; amount: number | null; height: number }

/**
 * Bar heights for a small phone chart. A bar is proportional to its amount; a day with no figure (null) has NO bar, which is not the
 * same as a day that sold nothing (0). Any real amount gets at least `minVisible` so a small day is not invisible.
 */
export function scaleBars(points: BarInput[], maxHeight: number, minVisible = 4): Bar[] {
  const max = points.reduce((m, p) => (p.amount !== null && p.amount > m ? p.amount : m), 0);
  return points.map((p) => ({
    key: p.key,
    amount: p.amount,
    height: p.amount === null || p.amount <= 0 || max <= 0 ? 0 : Math.max(minVisible, Math.round((p.amount / max) * maxHeight)),
  }));
}

/** The highest bar (the earliest wins a tie), or null when no point has a positive amount. */
export function peakOf(points: BarInput[]): { key: string; amount: number } | null {
  let best: { key: string; amount: number } | null = null;
  for (const p of points) if (p.amount !== null && p.amount > 0 && (best === null || p.amount > best.amount)) best = { key: p.key, amount: p.amount };
  return best;
}
