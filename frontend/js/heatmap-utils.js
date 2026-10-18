// Shared helpers for heatmap-style pages (全市場熱力 / 全球熱力).
// TW convention: red = up, green = down. Color intensity scales with |chg_pct|.

const _HEAT_RED = [220, 38, 38];    // #dc2626
const _HEAT_GREEN = [33, 197, 93];  // #21c55d

// Magnitude (in %) -> alpha, clamped. Tuned so ~0.3% has distinct tint and ~5%+ is fully vibrant.
function _heatAlpha(pct) {
  const mag = Math.min(Math.abs(pct ?? 0), 6);
  return 0.22 + (mag / 6) * 0.76;
}

// Futboardkk exact color styling:
// Down: Emerald Green tint; Up: Rose Red tint; Flat: Charcoal Slate
export function heatBg(pct) {
  if (pct == null || isNaN(pct)) return '#1c2430';
  if (Math.abs(pct) < 0.05) return '#222933';
  if (pct > 0) {
    // Up: Futboardkk uses a soft rose/crimson tone (#883b48, #a84252, #c84d60, etc.)
    const mag = Math.min(Math.abs(pct), 7);
    const alpha = 0.45 + (mag / 7) * 0.52;
    return `rgba(185, 64, 82, ${alpha.toFixed(2)})`;
  } else {
    // Down: Futboardkk uses a forest teal/emerald tone (#24695c, #2b7d6e, #318a7a, etc.)
    const mag = Math.min(Math.abs(pct), 7);
    const alpha = 0.42 + (mag / 7) * 0.55;
    return `rgba(38, 128, 108, ${alpha.toFixed(2)})`;
  }
}

export function heatText(pct) {
  if (pct == null || isNaN(pct)) return 'rgba(255,255,255,0.6)';
  return '#ffffff';
}

// ══ Squarified Treemap Layout (Bruls, Huizing, van Wijk) ═══════════════════
// Optimizes rectangles' aspect ratios toward 1:1, avoiding long slivers and overcrowding.

function _worstRatio(row, w) {
  let rMin = Infinity;
  let rMax = -Infinity;
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i]._normWeight;
    s += v;
    if (v < rMin) rMin = v;
    if (v > rMax) rMax = v;
  }
  if (s === 0 || w === 0) return Infinity;
  const s2 = s * s;
  const w2 = w * w;
  return Math.max((w2 * rMax) / s2, s2 / (w2 * rMin));
}

function _layoutRow(row, rect) {
  const isHoriz = rect.w >= rect.h;
  const side = isHoriz ? rect.h : rect.w;
  const rowArea = row.reduce((acc, it) => acc + it._normWeight, 0);
  const rowThickness = side > 0 ? rowArea / side : 0;

  let offset = 0;
  row.forEach(it => {
    const itemLen = rowThickness > 0 ? it._normWeight / rowThickness : 0;
    if (isHoriz) {
      it.x = rect.x;
      it.y = rect.y + offset;
      it.w = rowThickness;
      it.h = itemLen;
    } else {
      it.x = rect.x + offset;
      it.y = rect.y;
      it.w = itemLen;
      it.h = rowThickness;
    }
    offset += itemLen;
  });

  if (isHoriz) {
    rect.x += rowThickness;
    rect.w = Math.max(0, rect.w - rowThickness);
  } else {
    rect.y += rowThickness;
    rect.h = Math.max(0, rect.h - rowThickness);
  }
}

export function layoutSquarifiedTreemap(items, width, height) {
  // Give minimum weight floor to avoid invisible tiles
  const minFloor = 0.05;
  const valid = items.filter(it => (it.weight || 0) >= 0);
  if (!valid.length || width <= 0 || height <= 0) return [];

  const rawTotal = valid.reduce((s, it) => s + Math.max(minFloor, it.weight || minFloor), 0);
  const totalArea = width * height;

  const clone = valid.map(it => ({
    ...it,
    _normWeight: (Math.max(minFloor, it.weight || minFloor) / rawTotal) * totalArea,
  }));
  clone.sort((a, b) => b._normWeight - a._normWeight);

  const rect = { x: 0, y: 0, w: width, h: height };
  let row = [];

  for (let i = 0; i < clone.length; i++) {
    const item = clone[i];
    const side = Math.min(rect.w, rect.h);
    if (row.length === 0) {
      row.push(item);
    } else {
      const currentWorst = _worstRatio(row, side);
      const testWorst = _worstRatio([...row, item], side);
      if (testWorst <= currentWorst) {
        row.push(item);
      } else {
        _layoutRow(row, rect);
        row = [item];
      }
    }
  }
  if (row.length > 0) {
    _layoutRow(row, rect);
  }

  return clone;
}

export function layoutTreemap(items, width, height) {
  return layoutSquarifiedTreemap(items, width, height);
}

// Renders a two-level treemap (groups, each containing items) into `container`,
// sized to exactly fill the container's current pixel box.
export function renderTreemap(container, groups, opts) {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  const groupRects = layoutSquarifiedTreemap(groups, w, h);

  const html = groupRects.map(g => {
    // Futboardkk compact group header height
    const headerH = g.h > 28 ? Math.min(opts.groupHeaderHeight || 18, g.h * 0.22) : 0;
    const bodyH = Math.max(0, g.h - headerH);
    const itemRects = layoutSquarifiedTreemap(g.items || [], g.w, bodyH);
    const tiles = itemRects.map(it => {
      const content = it.w >= 28 && it.h >= 18 ? opts.tileContent(it, it.w, it.h) : '';
      return `<div class="heat-tile-abs" style="left:${it.x.toFixed(1)}px;top:${it.y.toFixed(1)}px;width:${Math.max(0, it.w - 1).toFixed(1)}px;height:${Math.max(0, it.h - 1).toFixed(1)}px;background:${opts.tileBg(it)};color:${opts.tileColor(it)}" title="${opts.tileTitle(it)}">${content}</div>`;
    }).join('');

    const headerHtml = headerH > 0
      ? `<div class="heat-group-header" style="height:${headerH.toFixed(1)}px">${opts.groupHeader(g)}</div>`
      : '';

    return `
      <div class="heat-group-abs" style="left:${g.x.toFixed(1)}px;top:${g.y.toFixed(1)}px;width:${g.w.toFixed(1)}px;height:${g.h.toFixed(1)}px">
        ${headerHtml}
        <div class="heat-group-body" style="height:${bodyH.toFixed(1)}px">${tiles}</div>
      </div>`;
  }).join('');
  container.innerHTML = html;
}
