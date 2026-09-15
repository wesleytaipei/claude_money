// FSC 現金增資/CB 核准 + TWSE 處置股票 panels.

import { api } from './api.js';
import { localISODate } from './utils.js';

// ── FSC Offerings ──────────────────────────────────────────────────────────
export const _fscCache = { date: '', data: null };

// ── TWSE Punish / Disposition (處置股票) ────────────────────────────────────
export const _punishCache = { date: '', data: null };
export let _fscSortKey = 'date';   // 'date' | 'code'
export let _fscSortAsc = true;     // true = oldest first (default)

export async function renderFscOfferings(force = false) {
  const tbody = document.getElementById('fsc-tbody');
  if (!tbody) return;

  const today = localISODate();
  if (!force && _fscCache.data && _fscCache.date === today) {
    _renderFscTable(_fscCache.data);
    return;
  }

  try {
    const data = await api('/api/fsc-offerings' + (force ? '?force=true' : ''));
    _fscCache.data = data;
    _fscCache.date = today;
    _renderFscTable(data);
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--danger)">❌ 資料載入失敗</td></tr>';
  }
}

export function fscSort(key) {
  if (_fscSortKey === key) {
    _fscSortAsc = !_fscSortAsc;   // toggle direction
  } else {
    _fscSortKey = key;
    _fscSortAsc = true;  // both default to ascending on first click
  }
  if (_fscCache.data) _renderFscTable(_fscCache.data);
}

export function _renderFscTable(data) {
  const tbody = document.getElementById('fsc-tbody');
  const countEl = document.getElementById('fsc-count');
  if (!tbody) return;

  let items = [...(data.items || [])];
  if (countEl) countEl.textContent = `共 ${items.length} 件`;

  // Update panel title with Excel date
  const titleEl = document.getElementById('fsc-panel-title');
  if (titleEl && data.excel_date) {
    titleEl.textContent = `📋 近期核准現金增資 / 轉換公司債 (${data.excel_date})`;
  }

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center; padding:16px">暫無資料</td></tr>';
    return;
  }

  // Sort
  items.sort((a, b) => {
    let va, vb;
    if (_fscSortKey === 'code') {
      va = parseInt(a.code) || 0;
      vb = parseInt(b.code) || 0;
    } else {
      va = a.eff_raw || '';
      vb = b.eff_raw || '';
    }
    return _fscSortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  // Update sort button labels
  const dateBtn = document.getElementById('fsc-sort-date');
  const codeBtn = document.getElementById('fsc-sort-code');
  if (dateBtn) dateBtn.textContent = `日期 ${_fscSortKey === 'date' ? (_fscSortAsc ? '↑' : '↓') : '↕'}`;
  if (codeBtn) codeBtn.textContent = `代號 ${_fscSortKey === 'code' ? (_fscSortAsc ? '↑' : '↓') : '↕'}`;

  // CB subtype colors: 有擔保=yellow, 無擔保=primary(blue), 海外=purple
  // CB subtype colors — keep clearly distinct from each other and from 現金增資 green
  const cbSubColor = { '有擔保': '#fb923c', '無擔保': '#38bdf8', '海外': '#f472b6' };

  const kindCell = r => {
    if (r.kind === '現金增資') {
      return `<span style="color:var(--green);font-weight:600">現金增資</span>`;
    }
    const subColor = cbSubColor[r.cb_sub] || '#94a3b8';
    const subTag = r.cb_sub
      ? ` <span style="color:${subColor};font-size:11px;font-weight:600">(${r.cb_sub})</span>`
      : '';
    return `<span style="color:#94a3b8;font-weight:600">轉換公司債</span>${subTag}`;
  };

  tbody.innerHTML = items.map(r => `<tr>
    <td class="mono" style="font-weight:600">${r.code}</td>
    <td style="font-weight:600">${r.name}</td>
    <td>${kindCell(r)}</td>
    <td class="mono small">${r.price || '—'}</td>
    <td class="mono small">${r.amount}</td>
    <td class="mono small muted">${r.eff_date}</td>
  </tr>`).join('');
}
