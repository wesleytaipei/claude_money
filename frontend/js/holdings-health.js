// 持股健檢 (holdings health check) — TW stocks + CB underlying stocks.
// MA5/10/20/60 站上/站下、今日漲跌%、大戶籌碼、外資/投信買賣超(近5日)。

import { api } from './api.js';
import { _cbToParentSym, _chipCellHtml } from './important.js';
import { INV_GROUP_MAP, state } from './state.js';
import { escapeAttr, fmtPct, fmtPrice, pnlClass } from './utils.js';

export let _healthData = null;
let _healthLoading = false;
export const _hhFilter = { q: '', sortKey: 'code', sortDir: 'asc' };

const _MA_COLS = [5, 10, 20, 60];

const _STOCK_CODE_RE = /^[1-9]\d{3}$/;   // 4-digit only — excludes ETFs/warrants (00xxxx)

function _collectHealthCodes() {
  const map = new Map();   // code -> { name, sources: Set }
  const add = (code, name, source) => {
    code = String(code || '').trim();
    if (!_STOCK_CODE_RE.test(code)) return;
    if (!map.has(code)) map.set(code, { name: name || '', sources: new Set() });
    const entry = map.get(code);
    if (!entry.name && name) entry.name = name;
    entry.sources.add(source);
  };

  const stockGroup = state.portfolio.investments.find(g => g.group === INV_GROUP_MAP.stock);
  for (const item of (stockGroup?.items || [])) {
    add(String(item.symbol || '').slice(0, 4), item.name, '股票');
  }
  const cbGroup = state.portfolio.investments.find(g => g.group === INV_GROUP_MAP.cb);
  for (const item of (cbGroup?.items || [])) {
    add(_cbToParentSym(item.symbol || ''), '', 'CB');
  }
  return map;
}

export async function renderHoldingsHealth(force = false) {
  const body = document.getElementById('inv-health-body');
  const sub = document.getElementById('inv-health-sub');
  if (!body) return;

  const codeMap = _collectHealthCodes();
  const codes = [...codeMap.keys()];
  if (codes.length === 0) {
    body.innerHTML = '<div class="empty-state">尚無台股 / 可轉債部位</div>';
    if (sub) sub.textContent = '';
    return;
  }

  if (!_healthData || force) {
    if (!_healthData) body.innerHTML = '<div class="empty-state">⏳ 載入中…</div>';
    _healthLoading = true;
    try {
      const data = await api(`/api/holdings-health?symbols=${codes.map(encodeURIComponent).join(',')}`);
      _healthData = data;
    } catch (e) {
      body.innerHTML = `<div class="empty-state">載入失敗：${e.message}</div>`;
      return;
    } finally {
      _healthLoading = false;
    }
  }
  _renderHealthTable(codeMap);
}

function _maBadge(above, ma) {
  if (above == null) return '<span class="muted">—</span>';
  const title = ma != null ? `均價 ${fmtPrice(ma)}` : '';
  return `<span title="${escapeAttr(title)}">${above ? '✅' : '❌'}</span>`;
}

function _flowCell(sumLots, days) {
  if (sumLots == null) return '<span class="muted">—</span>';
  const dayLines = (days || [])
    .map(d => `${d.date}: 外${d.foreign_lots == null ? '—' : d.foreign_lots}張 / 投${d.trust_lots == null ? '—' : d.trust_lots}張`)
    .join('\n');
  const sign = sumLots > 0 ? '+' : '';
  return `<span class="${pnlClass(sumLots)}" title="${escapeAttr(dayLines)}">${sign}${sumLots.toLocaleString()}</span>`;
}

export function _hhSetSort(key) {
  if (_hhFilter.sortKey === key) {
    _hhFilter.sortDir = _hhFilter.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    _hhFilter.sortKey = key;
    _hhFilter.sortDir = (key === 'code' || key === 'name') ? 'asc' : 'desc';
  }
  renderHoldingsHealth();
}

const _HH_COLS = [
  { key: 'code',   label: '代號' },
  { key: 'name',   label: '名稱' },
  { key: 'source', label: '來源' },
  { key: 'price',  label: '現價' },
  { key: 'chg',    label: '今日漲跌%' },
  { key: 'ma5',    label: '5MA' },
  { key: 'ma10',   label: '10MA' },
  { key: 'ma20',   label: '20MA' },
  { key: 'ma60',   label: '60MA(季)' },
  { key: 'chip',   label: '大戶籌碼(週)' },
  { key: 'foreign',label: '外資買賣超(張)' },
  { key: 'trust',  label: '投信買賣超(張)' },
];

const _SORT_VAL = {
  code:    r => r.code,
  name:    r => r.name,
  price:   r => r.ma?.price ?? -Infinity,
  chg:     r => r.ma?.chg_pct ?? -Infinity,
  ma5:     r => r.ma?.above_ma5 === true ? 1 : r.ma?.above_ma5 === false ? -1 : -2,
  ma10:    r => r.ma?.above_ma10 === true ? 1 : r.ma?.above_ma10 === false ? -1 : -2,
  ma20:    r => r.ma?.above_ma20 === true ? 1 : r.ma?.above_ma20 === false ? -1 : -2,
  ma60:    r => r.ma?.above_ma60 === true ? 1 : r.ma?.above_ma60 === false ? -1 : -2,
  chip:    r => r.chip?.run_change_pct ?? r.chip?.change_pct ?? -Infinity,
  foreign: r => r.flow?.foreign_sum_lots ?? -Infinity,
  trust:   r => r.flow?.trust_sum_lots ?? -Infinity,
};

function _renderHealthTable(codeMap) {
  const body = document.getElementById('inv-health-body');
  const sub = document.getElementById('inv-health-sub');
  if (!body || !_healthData) return;
  const { stocks = {}, flow_dates = [] } = _healthData;

  let rows = [...codeMap.entries()].map(([code, meta]) => {
    const s = stocks[code] || {};
    return { code, name: s.ma?.name || meta.name || code, sources: [...meta.sources], ma: s.ma, chip: s.chip, flow: s.flow };
  });

  const q = _hhFilter.q.trim().toUpperCase();
  if (q) rows = rows.filter(r => r.code.includes(q) || r.name.toUpperCase().includes(q));

  const getVal = _SORT_VAL[_hhFilter.sortKey] || _SORT_VAL.code;
  const dir = _hhFilter.sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let av = getVal(a), bv = getVal(b);
    if (typeof av === 'string') { av = av.toUpperCase(); bv = String(bv).toUpperCase(); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  const headHtml = '<tr>' + _HH_COLS.map(c => {
    const active = _hhFilter.sortKey === c.key;
    const arrow = active ? (_hhFilter.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
    const cls = c.key === 'code' || c.key === 'name' || c.key === 'source' ? '' : 'num';
    return `<th class="${cls}" style="cursor:pointer${active ? ';color:var(--primary-2)' : ''}" onclick="_hhSetSort('${c.key}')">${c.label}${arrow}</th>`;
  }).join('') + '</tr>';

  const rowsHtml = rows.map(r => {
    const chgPct = r.ma?.chg_pct;
    return `<tr>
      <td><span class="symbol-badge">${r.code}</span></td>
      <td>${r.name}</td>
      <td class="small muted">${r.sources.join('/')}</td>
      <td class="num">${r.ma?.price != null ? fmtPrice(r.ma.price) : '—'}</td>
      <td class="num ${chgPct == null ? '' : pnlClass(chgPct)}">${chgPct == null ? '—' : fmtPct(chgPct)}</td>
      <td class="num">${_maBadge(r.ma?.above_ma5, r.ma?.ma5)}</td>
      <td class="num">${_maBadge(r.ma?.above_ma10, r.ma?.ma10)}</td>
      <td class="num">${_maBadge(r.ma?.above_ma20, r.ma?.ma20)}</td>
      <td class="num">${_maBadge(r.ma?.above_ma60, r.ma?.ma60)}</td>
      <td class="num">${_chipCellHtml(r.chip)}</td>
      <td class="num">${_flowCell(r.flow?.foreign_sum_lots, r.flow?.days)}</td>
      <td class="num">${_flowCell(r.flow?.trust_sum_lots, r.flow?.days)}</td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    <div class="table-wrap">
      <table class="important-table">
        <thead>${headHtml}</thead>
        <tbody>${rowsHtml || `<tr><td colspan="${_HH_COLS.length}" style="text-align:center;padding:16px">尚無符合條件的個股</td></tr>`}</tbody>
      </table>
    </div>
  `;

  if (sub) {
    const range = flow_dates.length ? `${flow_dates[0]} ~ ${flow_dates[flow_dates.length - 1]}` : '—';
    sub.textContent = `外資/投信買賣超為近${flow_dates.length}個交易日加總 (${range})，單位：張`;
  }
}
