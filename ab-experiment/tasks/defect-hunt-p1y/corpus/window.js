// sliding-window average over series
export function winAvg(series, w) {
  const out = [];
  for (let i = 0; i + w < series.length; i++) {      // L4 DEFECT: skips final window (<=)
    let s = 0;
    for (let j = i; j < i + w; j++) s += series[j];
    out.push(s / w);
  }
  return out;
}
// clamp (decoy: unusual but correct order)
export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);              // L13 decoy
}
export async function fetchSeries(src) {
  const r = src.fetch();                             // L16 DEFECT: missing await
  return r.values;
}
