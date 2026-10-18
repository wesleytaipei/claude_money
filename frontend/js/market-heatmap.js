// 全市場熱力 (TW market-wide stock heatmap) page — single-screen treemap.

import { api } from './api.js';
import { escapeAttr, fmtPrice } from './utils.js';
import { heatBg, heatText, renderTreemap } from './heatmap-utils.js';

export let _marketHeatData = null;

export function onMarketHeatFilterChange() {
  _drawMarketHeatmap();
}

export function onMarketHeatModeChange() {
  renderMarketHeatmap(false);
}

export async function renderMarketHeatmap(force = false) {
  const body = document.getElementById('market-heatmap-body');
  const sub = document.getElementById('market-heatmap-sub');
  const mode = document.getElementById('mh-mode')?.value || 'themes';
  if (!body) return;
  if (!_marketHeatData || _marketHeatData.mode !== mode) {
    body.innerHTML = '<div class="empty-state">⏳ 載入族群熱力資料中…</div>';
  }
  try {
    _marketHeatData = await api(`/api/market-heatmap?mode=${mode}${force ? '&force=true' : ''}`);
    _drawMarketHeatmap();
    if (sub) {
      const d = _marketHeatData.updated_at ? new Date(_marketHeatData.updated_at) : null;
      const timeStr = d ? d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
      const staleTag = _marketHeatData.stale ? ' ⟳ 更新中…' : '';
      const modeLabel = mode === 'themes' ? 'Futboardkk 核心族群' : '全市場官方產業';
      sub.textContent = `${modeLabel} · ${_marketHeatData.stock_count || 0} 檔指標股 · 更新於 ${timeStr}${staleTag}`;
    }
    if (_marketHeatData.stale) setTimeout(() => renderMarketHeatmap(false), 8000);
  } catch (e) {
    body.innerHTML = `<div class="empty-state">載入失敗：${e.message}</div>`;
  }
}

function _drawMarketHeatmap() {
  const body = document.getElementById('market-heatmap-body');
  if (!body || !_marketHeatData) return;

  const minTurnover = Number(document.getElementById('mh-filter-turnover')?.value ?? 50000000);
  const maxPerGroup = Number(document.getElementById('mh-filter-top')?.value ?? 25);

  const groups = (_marketHeatData.groups || [])
    .map(g => {
      const filteredStocks = g.stocks
        .filter(s => (s.turnover || 0) >= minTurnover)
        .slice(0, maxPerGroup);
      return {
        // 板塊大小依包含的檔數決定（檔數多者版面大），每檔個股一律等權重均分
        weight: filteredStocks.length,
        label: g.industry,
        count: filteredStocks.length,
        items: filteredStocks.map(s => ({ ...s, weight: 1 })),
      };
    })
    .filter(g => g.items.length > 0);

  renderTreemap(body, groups, {
    groupHeaderHeight: 20,
    groupHeader: g => `<span class="hg-title">${g.label}</span>`,
    tileBg: it => heatBg(it.chg_pct),
    tileColor: it => heatText(it.chg_pct),
    tileTitle: it => escapeAttr(`${it.code} ${it.name}\n現價: ${fmtPrice(it.price)}\n漲跌: ${it.chg_pct > 0 ? '+' : ''}${it.chg_pct?.toFixed(2)}%\n成交值: ${((it.turnover || 0) / 1e8).toFixed(2)} 億`),
    tileContent: (it, w, h) => {
      const pct = it.chg_pct;
      const pctStr = pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
      if (w < 34 || h < 20) {
        return `<div class="heat-tile-compact">${pctStr}</div>`;
      }
      if (w < 48 || h < 30) {
        return `<div class="heat-tile-label">${it.name}</div><div class="heat-tile-pct">${pctStr}</div>`;
      }
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
