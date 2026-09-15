// 全市場熱力 (TW market-wide stock heatmap) page — single-screen treemap.

import { api } from './api.js';
import { escapeAttr, fmtPrice } from './utils.js';
import { heatBg, heatText, renderTreemap } from './heatmap-utils.js';

export let _marketHeatData = null;

export async function renderMarketHeatmap(force = false) {
  const body = document.getElementById('market-heatmap-body');
  const sub = document.getElementById('market-heatmap-sub');
  if (!body) return;
  if (!_marketHeatData) {
    body.innerHTML = '<div class="empty-state">⏳ 載入中…全市場成交資料 + 產業分類，首次載入可能需要 10-20 秒</div>';
  }
  try {
    _marketHeatData = await api(`/api/market-heatmap${force ? '?force=true' : ''}`);
    _drawMarketHeatmap();
    if (sub) {
      const d = _marketHeatData.updated_at ? new Date(_marketHeatData.updated_at) : null;
      const timeStr = d ? d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
      const staleTag = _marketHeatData.stale ? ' ⟳ 更新中…' : '';
      sub.textContent = `全台股個股熱力圖（不含ETF）· 依官方產業分類 · 色塊大小依成交值 · ${_marketHeatData.stock_count || 0} 檔 · 更新於 ${timeStr}${staleTag}`;
    }
    if (_marketHeatData.stale) setTimeout(() => renderMarketHeatmap(false), 8000);
  } catch (e) {
    body.innerHTML = `<div class="empty-state">載入失敗：${e.message}</div>`;
  }
}

function _drawMarketHeatmap() {
  const body = document.getElementById('market-heatmap-body');
  if (!body || !_marketHeatData) return;
  const groups = (_marketHeatData.groups || [])
    .filter(g => g.stocks.length)
    .map(g => ({
      weight: g.turnover, label: g.industry, count: g.stocks.length,
      items: g.stocks.map(s => ({ ...s, weight: s.turnover || 0 })),
    }));

  renderTreemap(body, groups, {
    groupHeaderHeight: 18,
    groupHeader: g => `<span>${g.label}</span><span class="hg-sub">${g.count}檔</span>`,
    tileBg: it => heatBg(it.chg_pct),
    tileColor: it => heatText(it.chg_pct),
    tileTitle: it => escapeAttr(`${it.code} ${it.name}\n現價 ${fmtPrice(it.price)}\n成交值 ${((it.turnover || 0) / 1e8).toFixed(2)} 億`),
    tileContent: it => {
      const pct = it.chg_pct;
      const pctStr = pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
      return `<div class="heat-tile-label">${it.name}</div><div class="heat-tile-pct">${pctStr}</div>`;
    },
  });
}

let _mhAutoRefreshTimer = null;
let _mhResizeBound = false;
export function _startMarketHeatAutoRefresh() {
  if (!_mhResizeBound) {
    _mhResizeBound = true;
    window.addEventListener('resize', () => { if (_marketHeatData) _drawMarketHeatmap(); });
  }
  if (_mhAutoRefreshTimer) return;
  _mhAutoRefreshTimer = setInterval(() => {
    if (!document.hidden) renderMarketHeatmap(false);
  }, 300000);
}
export function _stopMarketHeatAutoRefresh() {
  if (_mhAutoRefreshTimer) { clearInterval(_mhAutoRefreshTimer); _mhAutoRefreshTimer = null; }
}
