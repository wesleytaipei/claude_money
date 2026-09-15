// Shared helpers for heatmap-style pages (全市場熱力 / 全球熱力).
// TW convention: red = up, green = down. Color intensity scales with |chg_pct|.

const _HEAT_RED = [251, 113, 133];    // matches --red-2
const _HEAT_GREEN = [16, 185, 129];   // matches --green-2 (light theme; close enough in dark too)

// Magnitude (in %) -> alpha, clamped. Tuned so ~0.3% is barely visible and ~4%+ is fully saturated.
function _heatAlpha(pct) {
  const mag = Math.min(Math.abs(pct ?? 0), 4);
  return 0.10 + (mag / 4) * 0.75;
}

export function heatBg(pct) {
  if (pct == null || isNaN(pct)) return 'rgba(148,163,184,.12)';   // neutral slate
  const [r, g, b] = pct >= 0 ? _HEAT_RED : _HEAT_GREEN;
  return `rgba(${r},${g},${b},${_heatAlpha(pct).toFixed(2)})`;
}

export function heatText(pct) {
  if (pct == null || isNaN(pct)) return 'var(--muted)';
  return _heatAlpha(pct) > 0.45 ? '#fff' : (pct >= 0 ? 'var(--red-2)' : 'var(--green-2)');
}

// ══ Row-based treemap ═══════════════════════════════════════════════════
// Partitions `items` (each needs a numeric `weight`) into rows so the whole set
// exactly fills a `width` x `height` pixel box — no gaps, no overlaps. Not a
// fully squarified treemap (rows aren't re-optimized for aspect ratio), but a
// simple, robust approximation that's good enough for this purpose and never
// produces empty space or overflow. Returns items with {x,y,w,h} pixel rects
// added (all other item fields preserved).
export function layoutTreemap(items, width, height) {
  const valid = items.filter(it => (it.weight || 0) > 0);
  if (!valid.length || width <= 0 || height <= 0) return [];
  const total = valid.reduce((s, it) => s + it.weight, 0);

  const numRows = Math.max(1, Math.round(Math.sqrt(valid.length * (height / width || 1))));
  const targetPerRow = total / numRows;

  const rows = [];
  let current = [];
  let currentSum = 0;
  for (const it of valid) {
    current.push(it);
    currentSum += it.weight;
    if (currentSum >= targetPerRow && rows.length < numRows - 1) {
      rows.push({ items: current, weight: currentSum });
      current = [];
      currentSum = 0;
    }
  }
  if (current.length) rows.push({ items: current, weight: currentSum });

  const out = [];
  let y = 0;
  rows.forEach(row => {
    const rowH = (row.weight / total) * height;
    let x = 0;
    row.items.forEach(it => {
      const w = (it.weight / row.weight) * width;
      out.push({ ...it, x, y, w, h: rowH });
      x += w;
    });
    y += rowH;
  });
  return out;
}

// Renders a two-level treemap (groups, each containing items) into `container`,
// sized to exactly fill the container's current pixel box (call again on resize).
// opts: {
//   groupHeaderHeight: px,
//   groupHeader(group) -> HTML string,
//   tileBg(item), tileColor(item) -> CSS color,
//   tileTitle(item) -> attribute-safe string,
//   tileContent(item, w, h) -> HTML string (return '' to render a bare color block),
// }
export function renderTreemap(container, groups, opts) {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  const groupRects = layoutTreemap(groups, w, h);

  const html = groupRects.map(g => {
    const headerH = Math.min(opts.groupHeaderHeight, g.h);
    const bodyH = Math.max(0, g.h - headerH);
    const itemRects = layoutTreemap(g.items || [], g.w, bodyH);
    const tiles = itemRects.map(it => {
      const content = it.w >= 34 && it.h >= 20 ? opts.tileContent(it, it.w, it.h) : '';
      return `<div class="heat-tile-abs" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;background:${opts.tileBg(it)};color:${opts.tileColor(it)}" title="${opts.tileTitle(it)}">${content}</div>`;
    }).join('');
    return `
      <div class="heat-group-abs" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px">
        <div class="heat-group-header" style="height:${headerH}px">${opts.groupHeader(g)}</div>
        <div class="heat-group-body" style="height:${bodyH}px">${tiles}</div>
      </div>`;
  }).join('');
  container.innerHTML = html;
}
