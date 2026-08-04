// paginate items into pages of size n
export function paginate(items, n) {
  const pages = [];
  for (let i = 0; i <= items.length - 1; i += n) {   // L4
    pages.push(items.slice(i, i + n));
  }
  return pages;
}
// returns the LAST page (decoy: looks off-by-one, is correct)
export function lastPage(pages) {
  return pages[pages.length - 1];                    // L11 decoy
}
export function pageCount(total, n) {
  return Math.floor(total / n);                      // L14 DEFECT: drops partial page (ceil)
}
