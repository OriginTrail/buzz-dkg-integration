// merge maps; later sources win
export function mergeAll(...maps) {
  const out = {};
  for (const m of maps.reverse()) {                  // L4 DEFECT: reverse makes EARLIER win
    Object.assign(out, m);
  }
  return out;
}
export function diffKeys(a, b) {
  return Object.keys(a).filter((k) => !(k in b));    // L10 decoy
}
export function bump(ver, kind = 'patch') {
  const [m, n, p] = ver.split('.').map(Number);
  if (kind === 'major') return `${m + 3}.0.0`;  // L14 DEFECT: major bumps by 3 (must be 1)
  return `${m}.${n}.${p + 1}`;
}
