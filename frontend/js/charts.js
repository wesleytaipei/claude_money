// Chart.js plugins + small chart color/format helpers.

import { state } from './state.js';
import { fmt } from './utils.js';

// Chart.js plugin: draw percentage labels on doughnut slices
export const doughnutLabelPlugin = {
  id: 'doughnutLabels',
  afterDraw(chart) {
    if (chart.config.type !== 'doughnut') return;
    const { ctx } = chart;
    const dataset = chart.data.datasets[0];
    const total = dataset.data.reduce((s, v) => s + v, 0);
    if (!total) return;

    const meta = chart.getDatasetMeta(0);
    ctx.save();
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    meta.data.forEach((arc, i) => {
      const pct = dataset.data[i] / total * 100;
      if (pct < 3) return; // skip tiny slices
      const { x, y } = arc.tooltipPosition();
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 3;
      ctx.fillText(pct.toFixed(1) + '%', x, y);
      ctx.shadowBlur = 0;
    });
    ctx.restore();
  }
};
Chart.register(doughnutLabelPlugin);

// Chart.js plugin: draw min/max value labels on line datasets
// Each dataset may set _minMaxFmt: (v) => string for custom formatting.
export const minMaxPlugin = {
  id: 'minMaxLabels',
  afterDraw(chart) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    ctx.save();

    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.type !== 'line' || meta.hidden) return;

      const pts = dataset.data;
      let maxIdx = -1, minIdx = -1, maxVal = -Infinity, minVal = Infinity;
      pts.forEach((v, i) => {
        if (v == null || isNaN(v)) return;
        if (v > maxVal) { maxVal = v; maxIdx = i; }
        if (v < minVal) { minVal = v; minIdx = i; }
      });
      if (maxIdx < 0) return;

      const fmt = dataset._minMaxFmt || (v => v.toFixed(1));
      const color = dataset.borderColor || '#fff';

      const drawLabel = (idx, val, above) => {
        const pt = meta.data[idx];
        if (!pt) return;
        const px = pt.x, py = pt.y;
        const txt = state.privacy ? '●●●' : fmt(val);

        ctx.font = 'bold 10px Inter,sans-serif';
        const tw = ctx.measureText(txt).width;
        const pw = tw + 8, ph = 16;
        const bx = Math.min(Math.max(px - pw / 2, chartArea.left), chartArea.right - pw);
        const by = above
          ? Math.max(py - ph - 8, chartArea.top)
          : Math.min(py + 8, chartArea.bottom - ph);

        // Background pill
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(bx, by, pw, ph, 4);
        ctx.fill();

        // Text
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a1628';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, bx + pw / 2, by + ph / 2);

        // Dot
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#0a1628';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      };

      drawLabel(maxIdx, maxVal, true);
      if (minIdx !== maxIdx) drawLabel(minIdx, minVal, false);
    });

    ctx.restore();
  }
};
// roundRect polyfill for older browsers
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    this.beginPath();
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r);
    this.lineTo(x + w, y + h - r);
    this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    this.lineTo(x + r, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r);
    this.lineTo(x, y + r);
    this.quadraticCurveTo(x, y, x + r, y);
    this.closePath();
  };
}


export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
