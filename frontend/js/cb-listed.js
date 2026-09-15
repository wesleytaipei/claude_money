// 近期掛牌CB panel.

import { api } from './api.js';
import { localISODate } from './utils.js';

// ── CB Listed ──────────────────────────────────────────────────────────────
export const _cbListedCache = { date: '', data: null };
export let _cbSortKey = 'date';
export let _cbSortAsc = true;

export async function renderCbListed(force = false) {
  const tbody = document.getElementById('cb-tbody');
  if (!tbody) return;

  const today = localISODate();
  if (!force && _cbListedCache.data && _cbListedCache.date === today) {
    _renderCbTable(_cbListedCache.data);
    return;
  }

  try {
    const data = await api('/api/cb-listed' + (force ? '?force=true' : ''));
    _cbListedCache.data = data;
    _cbListedCache.date = today;
    _renderCbTable(data);
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--danger)">❌ 資料載入失敗</td></tr>';
  }
}

export function cbSort(key) {
  if (_cbSortKey === key) {
    _cbSortAsc = !_cbSortAsc;
  } else {
    _cbSortKey = key;
    _cbSortAsc = true;
  }
  if (_cbListedCache.data) _renderCbTable(_cbListedCache.data);
}

export function _renderCbTable(data) {
  const tbody = document.getElementById('cb-tbody');
  const countEl = document.getElementById('cb-count');
  const titleEl = document.getElementById('cb-panel-title');
  if (!tbody) return;

  let items = [...(data.items || [])];
  if (countEl) countEl.textContent = `共 ${items.length} 筆`;
  if (titleEl && data.data_date) titleEl.textContent = `📊 近期掛牌CB (${data.data_date})`;

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center; padding:16px">暫無資料</td></tr>';
    return;
  }

  // Sort
  items.sort((a, b) => {
    const va = _cbSortKey === 'code' ? (parseInt(a.cb_code) || 0) : (a.listing || '');
    const vb = _cbSortKey === 'code' ? (parseInt(b.cb_code) || 0) : (b.listing || '');
    return _cbSortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  // Update sort buttons
  const dateBtn = document.getElementById('cb-sort-date');
  const codeBtn = document.getElementById('cb-sort-code');
  if (dateBtn) dateBtn.textContent = `日期 ${_cbSortKey === 'date' ? (_cbSortAsc ? '↑' : '↓') : '↕'}`;
  if (codeBtn) codeBtn.textContent = `代號 ${_cbSortKey === 'code' ? (_cbSortAsc ? '↑' : '↓') : '↕'}`;

  // Color: highlight 有擔保 (anything that is NOT 無擔)
  const tcriCell = t => {
    const hasCollateral = !t.includes('無擔');
    const color = hasCollateral ? '#22c55e' : 'var(--muted)';
    return `<span style="color:${color}">${t}</span>`;
  };

  tbody.innerHTML = items.map(r => `<tr>
    <td class="mono" style="font-weight:600">${r.cb_code}</td>
    <td style="font-weight:600">${r.name}</td>
    <td class="small">${tcriCell(r.tcri)}</td>
    <td class="mono small">${r.amount}</td>
    <td class="mono small">${r.years}</td>
    <td class="mono small">${r.conv_price}</td>
    <td class="mono small muted">${r.listing}</td>
    <td class="small muted">${r.remarks}</td>
  </tr>`).join('');
}
