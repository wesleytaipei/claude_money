// 全球熱力 (global futures/index/fx/bond heatmap) page — single-screen treemap.

import { api } from './api.js';
import { escapeAttr } from './utils.js';
import { heatBg, heatText, renderTreemap } from './heatmap-utils.js';

export let _globalHeatData = null;

function _fmtHeatPrice(price, symbol) {
  if (price == null || isNaN(price)) return '—';
  if (symbol.endsWith('=X')) return Number(price).toFixed(4);
  if (price < 10) return Number(price).toFixed(3);
  if (price < 1000) return Number(price).toFixed(2);
  return Number(price).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export async function renderGlobalHeatmap(force = false) {
  const body = document.getElementById('global-heatmap-body');
  const sub = document.getElementById('global-heatmap-sub');
  if (!body) return;
  if (!_globalHeatData) body.innerHTML = '<div class="empty-state">⏳ 載入中…</div>';
  try {
    _globalHeatData = await api(`/api/global-heatmap${force ? '?force=true' : ''}`);
    _drawGlobalHeatmap();
    if (sub && _globalHeatData.updated_at) {
      const d = new Date(_globalHeatData.updated_at);
      sub.textContent = `全球指數期貨 · 能源 · 金屬 · 農產品 · 外匯 · 債券熱力圖 · 更新於 ${d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
  } catch (e) {
    body.innerHTML = `<div class="empty-state">載入失敗：${e.message}</div>`;
  }
}

function _drawGlobalHeatmap() {
  const body = document.getElementById('global-heatmap-body');
  if (!body || !_globalHeatData) return;
  const groups = (_globalHeatData.groups || [])
    .filter(g => g.items.length)
    .map(g => ({ weight: g.items.length, label: g.label, items: g.items.map(it => ({ ...it, weight: 1 })) }));

  renderTreemap(body, groups, {
    groupHeaderHeight: 20,
    groupHeader: g => `<span>${g.label}</span>`,
    tileBg: it => heatBg(it.chg_pct),
    tileColor: it => heatText(it.chg_pct),
    tileTitle: it => escapeAttr(`${it.label} (${it.symbol})\n${_fmtHeatPrice(it.price, it.symbol)}`),
    tileContent: it => {
      const pct = it.chg_pct;
      const pctStr = pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
      return `<div class="heat-tile-label">${it.label}</div><div class="heat-tile-pct">${pctStr}</div>`;
    },
  });
}

let _ghAutoRefreshTimer = null;
let _ghResizeBound = false;
export function _startGlobalHeatAutoRefresh() {
  if (!_ghResizeBound) {
    _ghResizeBound = true;
    window.addEventListener('resize', () => { if (_globalHeatData) _drawGlobalHeatmap(); });
  }
  if (_ghAutoRefreshTimer) return;
  _ghAutoRefreshTimer = setInterval(() => {
    if (!document.hidden) renderGlobalHeatmap(false);
  }, 180000);
}
export function _stopGlobalHeatAutoRefresh() {
  if (_ghAutoRefreshTimer) { clearInterval(_ghAutoRefreshTimer); _ghAutoRefreshTimer = null; }
}
