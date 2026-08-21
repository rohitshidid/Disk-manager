/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk).
 *
 * Lays rectangles out so their aspect ratios stay close to 1 -- long thin
 * slivers are impossible to read or click, which is the whole failure mode of
 * a naive slice-and-dice treemap.
 */
function worstRatio(row, side) {
  const sum = row.reduce((a, r) => a + r.area, 0);
  const max = Math.max(...row.map((r) => r.area));
  const min = Math.min(...row.map((r) => r.area));
  const s2 = sum * sum, w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

export function squarify(values, width, height) {
  const total = values.reduce((a, v) => a + v.value, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const items = values.map((v) => ({ ...v, area: v.value * scale })).filter((v) => v.area > 0);

  const out = [];
  let x = 0, y = 0, w = width, h = height;
  let row = [];
  let i = 0;

  const layoutRow = () => {
    const sum = row.reduce((a, r) => a + r.area, 0);
    const vertical = w >= h;
    const thickness = sum / (vertical ? h : w);
    let offset = 0;
    for (const r of row) {
      const len = r.area / thickness;
      if (vertical) out.push({ ...r, x, y: y + offset, w: thickness, h: len });
      else out.push({ ...r, x: x + offset, y, w: len, h: thickness });
      offset += len;
    }
    if (vertical) { x += thickness; w -= thickness; }
    else { y += thickness; h -= thickness; }
    row = [];
  };

  while (i < items.length) {
    const side = Math.min(w, h);
    const next = items[i];
    if (!row.length) { row.push(next); i++; continue; }
    if (worstRatio(row, side) >= worstRatio([...row, next], side)) { row.push(next); i++; }
    else { layoutRow(); }
    if (w <= 0 || h <= 0) break;
  }
  if (row.length) layoutRow();
  return out;
}
