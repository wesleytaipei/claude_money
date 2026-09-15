// 季線選股 (stock zones) page.

import { api } from './api.js';
import { toggleGroup } from './routing.js';
import { state } from './state.js';
import { escapeAttr, fmtPct, fmtPrice } from './utils.js';

// ══ 季線選股 ═══════════════════════════════════════════════════════════
export const _STOCK_ZONE_META = {
  strong: { label: '強勢區', hint: '現價 > 季線 +5%',    color: '#f87171' },
  season: { label: '季線區', hint: '季線 ±5% 內',        color: '#a7b0c8' },
  repair: { label: '修復區', hint: '季線 -5% ~ -10%',    color: '#34d399' },
};

export let _stockZonesData = null;
export const _szFilter = { q: '', market: 'all', sortKey: 'pct', sortDir: 'desc', maxAbsPct: '', ma5: 'all', chg: 'all' };
export const _SZ_SORT_COLS = [
  { key: 'code',    label: '代號' },
  { key: 'name',    label: '名稱' },
  { key: 'market',  label: '市場' },
  { key: 'price',   label: '現價' },
  { key: 'chg_pct', label: '今日漲幅%' },
  { key: 'ma',      label: '季線' },
  { key: 'pct',     label: '季線乖離%' },
  { key: 'above_ma5', label: '>5日均' },
];

export async function renderStockZonesPage(force = false) {
  const body = document.getElementById('stock-zones-body');
  if (!body) return;
  if (!_stockZonesData) {
    body.innerHTML = '<div class="empty-state">⏳ 載入中…首次建立需回補約 65 個交易日的全市場收盤價，可能需要 1-2 分鐘</div>';
  }
  try {
    _stockZonesData = await api(`/api/stock-zones${force ? '?force=true' : ''}`);
    _renderStockZonesSummary();
    _renderStockZonesFilterBar();
    _renderStockZones();
    const sub = document.getElementById('stock-zones-sub');
    if (sub) {
      const asOf = _stockZonesData.as_of;
      const dateStr = asOf ? `${asOf.slice(0, 4)}/${asOf.slice(4, 6)}/${asOf.slice(6, 8)}` : '—';
      const staleTag = _stockZonesData.stale ? ' ⟳ 更新中…' : '';
      sub.textContent = `全市場個股（不含ETF）現價 vs 60日均線（季線）分區 · 資料日期 ${dateStr}${staleTag}`;
    }
    if (_stockZonesData.stale) setTimeout(() => renderStockZonesPage(false), 8000);
  } catch (e) {
    body.innerHTML = `<div class="empty-state">載入失敗：${e.message}</div>`;
  }
}

export function _renderStockZonesSummary() {
  const el = document.getElementById('stock-zones-summary');
  if (!el || !_stockZonesData) return;
  const zones = _stockZonesData.zones || {};
  const all = [...(zones.strong || []), ...(zones.season || []), ...(zones.repair || [])];
  const total = all.length;
  const up = all.filter(s => s.chg_pct > 0).length;
  const down = all.filter(s => s.chg_pct < 0).length;
  const aboveMa5 = all.filter(s => s.above_ma5 === true).length;
  const pct = n => total ? (n / total * 100).toFixed(0) + '%' : '—';

  el.innerHTML = `
    <div class="inv-stat">
      <div class="inv-stat-label">分類總檔數</div>
      <div class="inv-stat-value">${total}</div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">${_STOCK_ZONE_META.strong.label}</div>
      <div class="inv-stat-value" style="color:${_STOCK_ZONE_META.strong.color}">${zones.strong?.length || 0} <span class="small muted">(${pct(zones.strong?.length || 0)})</span></div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">${_STOCK_ZONE_META.season.label}</div>
      <div class="inv-stat-value">${zones.season?.length || 0} <span class="small muted">(${pct(zones.season?.length || 0)})</span></div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">${_STOCK_ZONE_META.repair.label}</div>
      <div class="inv-stat-value" style="color:${_STOCK_ZONE_META.repair.color}">${zones.repair?.length || 0} <span class="small muted">(${pct(zones.repair?.length || 0)})</span></div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">今日漲/跌家數</div>
      <div class="inv-stat-value"><span style="color:var(--red-2)">${up}</span> / <span style="color:var(--green-2)">${down}</span></div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">站上5日均</div>
      <div class="inv-stat-value">${aboveMa5} <span class="small muted">(${pct(aboveMa5)})</span></div>
    </div>
  `;
}

export function _szHasActiveFilter() {
  return !!_szFilter.q || _szFilter.market !== 'all' || !!_szFilter.maxAbsPct
    || _szFilter.ma5 !== 'all' || _szFilter.chg !== 'all';
}

export function _szClearFilters() {
  Object.assign(_szFilter, { q: '', market: 'all', maxAbsPct: '', ma5: 'all', chg: 'all' });
  _renderStockZonesFilterBar();
  _renderStockZones();
}

export function _renderStockZonesFilterBar() {
  const el = document.getElementById('stock-zones-filter');
  if (!el || !_stockZonesData) return;
  el.style.display = 'flex';
  const focusedId = document.activeElement?.id?.startsWith('sz-') ? document.activeElement.id : null;
  const selStart = document.activeElement?.selectionStart;

  const toggleGroup = (field, opts) => opts.map(([val, label]) => {
    const on = _szFilter[field] === val;
    return `<button class="btn-ghost" style="padding:4px 10px;font-size:11px${on ? ';background:rgba(99,102,241,.2);color:var(--primary-2);border-color:var(--primary)' : ''}"
      onclick="_szFilter.${field}='${val}'; _renderStockZonesFilterBar(); _renderStockZones();">${label}</button>`;
  }).join('');

  el.innerHTML = `
    <input id="sz-search" type="text" placeholder="搜尋代號或名稱" value="${escapeAttr(_szFilter.q)}"
      oninput="_szFilter.q = this.value; _renderStockZonesFilterBar(); _renderStockZones();"
      style="flex:1;min-width:120px;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);outline:none" />
    <div style="display:flex;gap:5px">${toggleGroup('market', [['all','全部'],['tse','上市'],['otc','上櫃']])}</div>
    <div style="width:1px;height:18px;background:var(--border)"></div>
    <span style="font-size:11px;color:var(--muted)">季線乖離率≤</span>
    <input id="sz-max-pct" type="number" min="0" step="0.5" placeholder="不限" value="${escapeAttr(_szFilter.maxAbsPct)}"
      oninput="_szFilter.maxAbsPct = this.value; _renderStockZonesFilterBar(); _renderStockZones();"
      style="width:64px;padding:6px 8px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);outline:none" />
    <span style="font-size:11px;color:var(--muted)">%</span>
    <div style="width:1px;height:18px;background:var(--border)"></div>
    <span style="font-size:11px;color:var(--muted)">5日均</span>
    <div style="display:flex;gap:5px">${toggleGroup('ma5', [['all','全部'],['above','站上'],['below','未站上']])}</div>
    <div style="width:1px;height:18px;background:var(--border)"></div>
    <span style="font-size:11px;color:var(--muted)">今日</span>
    <div style="display:flex;gap:5px">${toggleGroup('chg', [['all','全部'],['up','上漲'],['down','下跌']])}</div>
    ${_szHasActiveFilter() ? `<button class="btn-ghost" style="padding:4px 10px;font-size:11px" onclick="_szClearFilters()">✕ 清除篩選</button>` : ''}
  `;
  // Re-focus whichever input the user was mid-typing in
  if (focusedId) {
    const input = document.getElementById(focusedId);
    if (input) {
      input.focus();
      if (selStart != null && input.setSelectionRange) input.setSelectionRange(selStart, selStart);
    }
  }
}

export function _szSetSort(key) {
  if (_szFilter.sortKey === key) {
    _szFilter.sortDir = _szFilter.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    _szFilter.sortKey = key;
    _szFilter.sortDir = (key === 'code' || key === 'name' || key === 'market') ? 'asc' : 'desc';
  }
  _renderStockZones();
}

export function _szFilterSort(list) {
  let out = list;
  if (_szFilter.market !== 'all') out = out.filter(s => s.market === _szFilter.market);
  const q = _szFilter.q.trim().toUpperCase();
  if (q) out = out.filter(s => s.code.toUpperCase().includes(q) || (s.name || '').toUpperCase().includes(q));
  const maxAbs = parseFloat(_szFilter.maxAbsPct);
  if (!isNaN(maxAbs) && maxAbs >= 0) out = out.filter(s => Math.abs(s.pct) <= maxAbs);
  if (_szFilter.ma5 === 'above') out = out.filter(s => s.above_ma5 === true);
  else if (_szFilter.ma5 === 'below') out = out.filter(s => s.above_ma5 === false);
  if (_szFilter.chg === 'up') out = out.filter(s => s.chg_pct > 0);
  else if (_szFilter.chg === 'down') out = out.filter(s => s.chg_pct < 0);
  const { sortKey, sortDir } = _szFilter;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...out].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') { av = av.toUpperCase(); bv = (bv || '').toUpperCase(); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

export function _renderStockZones() {
  const body = document.getElementById('stock-zones-body');
  if (!body || !_stockZonesData) return;
  const zones = _stockZonesData.zones || {};
  const headHtml = '<tr>' + _SZ_SORT_COLS.map(c => {
    const active = _szFilter.sortKey === c.key;
    const arrow = active ? (_szFilter.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
    const cls = c.key === 'code' || c.key === 'name' ? '' : 'num';
    return `<th class="${cls}" style="cursor:pointer${active ? ';color:var(--primary-2)' : ''}" onclick="_szSetSort('${c.key}')">${c.label}${arrow}</th>`;
  }).join('') + '</tr>';

  body.innerHTML = ['strong', 'season', 'repair'].map(key => {
    const meta = _STOCK_ZONE_META[key];
    const full = zones[key] || [];
    const list = _szFilterSort(full);
    const rows = list.map(s => `
      <tr>
        <td><span class="symbol-badge">${s.code}</span></td>
        <td>${s.name}</td>
        <td class="num">${s.market === 'otc' ? '櫃' : '市'}</td>
        <td class="num">${fmtPrice(s.price)}</td>
        <td class="num" style="color:${s.chg_pct == null ? 'var(--muted)' : s.chg_pct >= 0 ? 'var(--red-2)' : 'var(--green-2)'}">${s.chg_pct == null ? '—' : fmtPct(s.chg_pct)}</td>
        <td class="num">${fmtPrice(s.ma)}</td>
        <td class="num" style="color:${s.pct >= 0 ? 'var(--red-2)' : 'var(--green-2)'}">${fmtPct(s.pct)}</td>
        <td class="num" title="5日均價 ${s.ma5 == null ? '—' : fmtPrice(s.ma5)}">${s.above_ma5 == null ? '—' : s.above_ma5 ? '✅' : '❌'}</td>
      </tr>`).join('');
    const countLabel = list.length === full.length ? `${full.length} 檔` : `${list.length} / ${full.length} 檔`;
    return `
      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head">
          <h3 style="color:${meta.color}">${meta.label}</h3>
          <span class="panel-sub">${meta.hint} · ${countLabel}</span>
        </div>
        <div class="table-wrap" style="max-height:420px;overflow-y:auto">
          <table class="important-table">
            <thead>${headHtml}</thead>
            <tbody>${rows || `<tr><td colspan="${_SZ_SORT_COLS.length}" style="text-align:center;padding:16px">尚無符合條件的個股</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}
