// 投資部位 (investments) page + position modal.

import { api, savePortfolio } from './api.js';
import { _cbListedCache } from './cb-listed.js';
import { calcTotals, renderDashboard } from './dashboard.js';
import { _etfFocusCodes, _etfState } from './etf.js';
import { _fscCache, _punishCache } from './fsc.js';
import { _cbToParentSym, _chipCache, _chipCellHtml, _importantCache } from './important.js';
import { closeModal, currentPage } from './routing.js';
import { INV_GROUP_MAP, _invExpandedGroups, groupKey, state } from './state.js';
import { dateWarnClass, escapeAttr, fmtFull, fmtPct, fmtPrice, localISODate, percentWarnClass, pnlClass, toast } from './utils.js';

// ══ Render: Investments ═════════════════════════════════════════════════
export function renderInvestmentsPage() {
  const tablePanel = document.getElementById('inv-table-panel');
  const healthPanel = document.getElementById('inv-health-panel');
  const summaryEl = document.getElementById('inv-summary');
  if (state.currentInv === 'health') {
    if (tablePanel) tablePanel.style.display = 'none';
    if (summaryEl) summaryEl.style.display = 'none';
    if (healthPanel) healthPanel.style.display = '';
    renderHoldingsHealth();
    return;
  }
  if (tablePanel) tablePanel.style.display = '';
  if (summaryEl) summaryEl.style.display = '';
  if (healthPanel) healthPanel.style.display = 'none';

  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  const items = group ? group.items : [];

  // Auto-load CB suspension status when viewing CB tab and not yet fetched
  if (state.currentInv === 'cb' && !state._cbSuspensionLoaded) {
    state._cbSuspensionLoaded = true;
    api('/api/cb-suspension/status').then(data => {
      const suspended = data.suspended || {};  // {code: "start - end"}
      const cbGroup = state.portfolio.investments.find(g => g.group === '可轉債');
      if (cbGroup) {
        for (const item of cbGroup.items) {
          const dateRange = suspended[item.symbol];
          item._suspended        = dateRange !== undefined;
          item._suspension_dates = dateRange || null;
        }
      }
      renderInvestmentsPage();
    }).catch(() => {});
  }

  // Auto-load TWSE disposition list (stock + CB tabs); refresh once per calendar day
  if (state.currentInv === 'stock' || state.currentInv === 'cb') {
    const today = localISODate();
    if (!_punishCache.data || _punishCache.date !== today) {
      _punishCache.date = today;  // prevent repeated concurrent fetches
      api('/api/punish/status').then(d => {
        _punishCache.data = d.punished || {};
        _punishCache.date = today;
        renderInvestmentsPage();
      }).catch(() => {});
    }
  }

  document.getElementById('inv-title').textContent = groupName;
  const mergeToggle = document.getElementById('inv-merge-toggle');
  if (mergeToggle) mergeToggle.checked = state.mergeSameSymbol;

  // Summary — use Σ _pnl_twd so margin doesn't inflate the figure
  let totalMV = 0, totalCost = 0, totalPnL = 0;
  for (const item of items) {
    totalMV   += item._mv_twd  || 0;
    totalCost += item._cost_twd || 0;
    totalPnL  += item._pnl_twd || 0;
  }
  const pnl    = totalPnL;
  const pnlPct = totalCost > 0 ? (pnl / totalCost * 100) : 0;

  // Per-broker 整戶維持率 (stock tab only, for positions with 融資)
  const _bm = {};
  if (state.currentInv === 'stock') {
    for (const item of items) {
      if (!(item._margin > 0)) continue;
      const b = (item.broker || '').trim() || '(未設定)';
      if (!_bm[b]) _bm[b] = { mv: 0, margin: 0 };
      _bm[b].mv += item._mv_twd || 0;
      _bm[b].margin += item._margin || 0;
    }
  }
  const _bmEntries = Object.entries(_bm);

  document.getElementById('inv-summary').innerHTML = `
    <div class="inv-stat">
      <div class="inv-stat-label">總市值</div>
      <div class="inv-stat-value">${fmtFull(totalMV)}</div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">總成本</div>
      <div class="inv-stat-value">${fmtFull(totalCost)}</div>
    </div>
    ${_bmEntries.length > 0 ? `<div class="inv-stat">
      <div class="inv-stat-label">整戶維持率</div>
      <div class="inv-stat-value" style="font-size:15px">${_bmEntries.map(([b, d]) => {
        const r = d.margin > 0 ? d.mv / d.margin * 100 : 0;
        const color = r < 130 ? 'var(--red-2)' : r < 150 ? 'var(--orange)' : 'var(--green)';
        return `${b}&nbsp;<span style="color:${color}">${r.toFixed(0)}%</span>`;
      }).join('&ensp;&ensp;')}</div>
    </div>` : ''}
    <div class="inv-stat">
      <div class="inv-stat-label">損益</div>
      <div class="inv-stat-value ${pnlClass(pnl)}">${pnl >= 0 ? '+' : '-'}${fmtFull(Math.abs(pnl))}&nbsp;<span style="font-size:13px">(${fmtPct(pnlPct)})</span></div>
    </div>
  `;

  // Table
  const isCB = state.currentInv === 'cb';
  const isStock = state.currentInv === 'stock';
  const isUS = state.currentInv === 'us';
  const cur = isUS ? 'USD' : 'TWD';
  const showStar = isCB || isStock;

  // CB: hide 預估市值; 今日漲幅% at end of cbHeaders shows underlying stock's change%
  // Non-CB: 今日漲幅% stays after 目前價格
  const baseHeaders = isCB
    ? ['代號', '名稱', '股數', '買入均價', '目前價格', '投入成本', '預估損益', '損益%']
    : isStock
      ? ['代號', '名稱', '股數', '買入均價', '目前價格', '今日漲幅%', '投入成本', '預估市值', '預估損益', '損益%', '大戶籌碼', '購入券商']
      : ['代號', '名稱', '股數', '買入均價', '目前價格', '今日漲幅%', '投入成本', '預估市值', '預估損益', '損益%', '購入券商'];
  const cbHeaders = ['CB到期日', 'CBAS到期日', '剩餘張數', '餘額%', '轉換價', '溢價率%', '現股價格', '大戶籌碼', '今日漲幅%', '停止轉換', '購入券商'];
  const headers = isCB ? ['★', ...baseHeaders, ...cbHeaders] : (isStock ? ['★', ...baseHeaders] : baseHeaders);

  // '代號' & '名稱' are non-numeric; everything else is right-aligned
  const numFromIdx = showStar ? 3 : 2;   // ★ shifts the threshold by 1

  // Build alert map for TW stocks + CB underlying: stockCode → [reason strings]
  const alertMap = {};
  if (showStar) {
    if (_cbListedCache.data?.items) {
      for (const r of _cbListedCache.data.items) {
        const sc = String(r.cb_code).slice(0, 4);
        if (!alertMap[sc]) alertMap[sc] = [];
        alertMap[sc].push(`近期掛牌CB: ${r.cb_code} ${r.name} (${r.listing})`);
      }
    }
    if (_fscCache.data?.items) {
      for (const r of _fscCache.data.items) {
        const sc = String(r.code);
        if (!alertMap[sc]) alertMap[sc] = [];
        alertMap[sc].push(`近期核准${r.kind}: ${r.name} (${r.eff_date})`);
      }
    }

    // ── ETF追蹤 cross-reference ──────────────────────────────────────────
    const _opShort = { '新增建倉': '新增建倉', '股數加碼': '加碼', '股數減碼': '減碼', '全數清倉': '清倉' };
    for (const etfCode of _etfFocusCodes) {
      const etfData = _etfState.cache[etfCode];
      if (!etfData?.holdings) continue;
      const ranked = [...etfData.holdings]
        .filter(h => (h.currentWeightPercent ?? 0) > 0)
        .sort((a, b) => (b.currentWeightPercent || 0) - (a.currentWeightPercent || 0));
      const top10  = new Set(ranked.slice(0, 10).map(h => h.symbol));
      const rankOf = new Map(ranked.map((h, i) => [h.symbol, i + 1]));
      for (const h of etfData.holdings) {
        const parts = [];
        if (top10.has(h.symbol)) parts.push(`TOP${rankOf.get(h.symbol)}`);
        const opS = _opShort[h.operationType];
        if (opS) parts.push(opS);
        if (!parts.length) continue;
        if (!alertMap[h.symbol]) alertMap[h.symbol] = [];
        alertMap[h.symbol].push(`[${etfCode}] ${parts.join(' ')}`);
      }
    }

    // ── 重要資訊 cross-reference: TSM ADR → 2330 ─────────────────────────
    if (_importantCache.data) {
      const tsm = _importantCache.data.tsm_adr;
      if (tsm?.price && tsm.price !== '-') {
        const dir = String(tsm.change || '').startsWith('+') ? '▲' : '▼';
        if (!alertMap['2330']) alertMap['2330'] = [];
        alertMap['2330'].push(`TSM ADR ${dir} ${tsm.change_pct}`);
      }
    }

    // ── TWSE 處置股票 ──────────────────────────────────────────────────────
    if (_punishCache.data) {
      for (const [code, info] of Object.entries(_punishCache.data)) {
        // Normalize: strip leading zeros for 4-digit codes, keep as-is otherwise
        const sc = code.replace(/^0+/, '') || code;
        if (!alertMap[sc]) alertMap[sc] = [];
        alertMap[sc].push(`🚨 處置中: ${info.name} | ${info.period} | ${info.measure}`);
      }
    }
  }
  document.getElementById('inv-thead').innerHTML =
    '<tr>' + headers.map((h, i) => `<th class="${i >= numFromIdx ? 'num' : ''}">${h}</th>`).join('') + '<th></th></tr>';

  const tbody = document.getElementById('inv-tbody');
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="empty-state">尚無部位</td></tr>`;
    return;
  }

  const sortedItems = [...items].sort((a, b) => {
    const sa = (a.symbol || a.name || '').toUpperCase();
    const sb = (b.symbol || b.name || '').toUpperCase();
    return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
  });
  // Map sorted index back to original index for edit/delete ops
  const origIdx = sortedItems.map(item => items.indexOf(item));

  // Async chip data loading — one batch request for all uncached symbols
  function _loadChips(syms) {
    // Update cells for already-cached symbols immediately
    for (const sym of syms) {
      if (_chipCache[sym] != null) {
        document.querySelectorAll(`td[data-chip="${sym}"]`).forEach(td => {
          td.innerHTML = _chipCellHtml(_chipCache[sym]);
        });
      }
    }

    const toFetch = syms.filter(s => _chipCache[s] === undefined);
    if (toFetch.length === 0) return;

    // Mark as loading (shows ⋯)
    toFetch.forEach(s => { _chipCache[s] = null; });

    // Single batch request — backend fetches all in parallel
    api(`/api/chip-data/batch?symbols=${toFetch.map(encodeURIComponent).join(',')}`)
      .then(results => {
        for (const [sym, data] of Object.entries(results)) {
          _chipCache[sym] = data;
          document.querySelectorAll(`td[data-chip="${sym}"]`).forEach(td => {
            td.innerHTML = _chipCellHtml(data);
          });
        }
      })
      .catch(() => {
        toFetch.forEach(sym => {
          _chipCache[sym] = { error: true };
          document.querySelectorAll(`td[data-chip="${sym}"]`).forEach(td => {
            td.innerHTML = _chipCellHtml({ error: true });
          });
        });
      });
  }

  // Build one <tr>. `idx` is the item's index in the unsorted group.items array
  // (undefined for a synthetic group-summary row, which uses `memberIdxs` instead).
  function _invRowHtml(item, idx, opts = {}) {
    const { isSub = false, isSummary = false, groupKey = '', memberIdxs = [], memberCount = 0 } = opts;
    const mv = item._mv || 0;
    const pnl = item._pnl || 0;
    const pnlPct = item._pnl_pct || 0;
    const rowCls = [item.highlighted ? 'highlighted' : '', isSub ? 'inv-subrow' : '', isSummary ? 'inv-group-summary' : ''].filter(Boolean).join(' ');

    const priceCell = (v) => fmtPrice(v);

    // Build a change% cell with optional limit-up/down highlight
    const makeChgCell = (pct) => {
      if (pct == null) return `<td class="num muted">—</td>`;
      const isLimitUp   = pct >=  9.8;
      const isLimitDown = pct <= -9.8;
      const cls = isLimitUp ? 'cell-limit-up' : isLimitDown ? 'cell-limit-down' : pnlClass(pct);
      return `<td class="num ${cls}">${fmtPct(pct)}</td>`;
    };

    const chipSym = isStock ? String(item.symbol || '').slice(0, 4)
                  : isCB   ? _cbToParentSym(item.symbol || '')
                  : null;
    const chipTdEl = chipSym
      ? `<td class="num" data-chip="${chipSym}">${_chipCellHtml(_chipCache[chipSym])}</td>`
      : '<td class="num muted">—</td>';
    // Stock: chip goes at end of baseCells; CB: chip goes into cbCells after 現股價格
    const chipTd = (chipSym && !isCB) ? chipTdEl : '';

    const collapsed = isSummary && !_invExpandedGroups.has(groupKey);
    const leadPrefix = isSub
      ? '<span class="muted" style="margin-right:2px">└</span>'
      : isSummary
        ? `<span class="muted" style="margin-right:4px">${collapsed ? '▸' : '▾'}</span>`
        : '';
    const baseCells = `
      <td>${leadPrefix}<span class="symbol-badge">${item.symbol || '—'}</span>${
        isSummary ? `<span class="small muted" style="margin-left:4px">×${memberCount}</span>` : ''
      }</td>
      <td>${item.note
        ? `<span title="${escapeAttr(item.note)}" style="cursor:help;border-bottom:1px dotted var(--muted)">${item.name || '—'}</span>`
        : (item.name || '—')}</td>
      <td class="num">${(Number(item.shares) || 0).toLocaleString()}</td>
      <td class="num">${priceCell(item.entry_price)}</td>
      <td class="num">${priceCell(item.current_price)}</td>
      ${isCB ? '' : makeChgCell(item._change_pct)}
      <td class="num">${fmtFull(item.cost).replace('NT$ ', '')}${
        isStock && item._margin > 0
          ? `<br><span class="small muted">融資 ${(item._margin/10000).toFixed(0)}萬</span>`
          : ''
      }</td>
      ${isCB ? '' : `<td class="num">${fmtFull(mv).replace('NT$ ', '')}</td>`}
      <td class="num ${pnlClass(pnl)}">${pnl >= 0 ? '+' : ''}${fmtFull(pnl).replace('NT$ ', '')}</td>
      <td class="num ${pnlClass(pnlPct)}">${fmtPct(pnlPct)}</td>
      ${chipTd}
    `;

    let cbCells = '';
    if (isCB) {
      const remainPct = (Number(item.issued_shares) > 0)
        ? (Number(item.remain_shares) / Number(item.issued_shares) * 100) : null;
      cbCells = `
        <td class="num ${dateWarnClass(item.cb_due_date)}">${item.cb_due_date || '—'}</td>
        <td class="num ${dateWarnClass(item.cbas_due_date)}">${item.cbas_due_date || '—'}</td>
        <td class="num ${percentWarnClass(remainPct, 50, 80)}">${item.remain_shares || '—'}</td>
        <td class="num ${percentWarnClass(remainPct, 50, 80)}">${remainPct != null ? remainPct.toFixed(1) + '%' : '—'}</td>
        <td class="num">${item.conversion_price ? Number(item.conversion_price).toFixed(2) : '—'}</td>
        <td class="num ${percentWarnClass(item.premium_rate, 5, 20)}">${item.premium_rate != null && item.premium_rate !== 0 ? Number(item.premium_rate).toFixed(2) + '%' : '—'}</td>
        <td class="num">${item.stock_price ? Number(item.stock_price).toFixed(2) : '—'}</td>
        ${chipTdEl}
        ${makeChgCell(item._stock_change_pct)}
        <td style="text-align:center">${
          item._suspended === true
            ? (() => {
                // Parse start date from "YYYY/MM/DD - YYYY/MM/DD"
                const startStr = (item._suspension_dates || '').split(' - ')[0];
                const startDate = startStr ? new Date(startStr.replace(/\//g, '-')) : null;
                const today = new Date(); today.setHours(0,0,0,0);
                const isPreWarn = startDate && startDate > today;
                const label = isPreWarn ? '⚠️ 即將停止轉換' : '🔴 停止轉換中';
                return `<span class="status-dot ${isPreWarn ? 'orange' : 'red'}" title="${label}&#10;${item._suspension_dates || ''}"></span>`;
              })()
            : item._suspended === false
              ? '<span class="status-dot green" title="可轉換"></span>'
              : '—'
        }</td>
      `;
    }

    const _symStr = String(item.symbol || '');
    const autoReasons = showStar && _symStr
      ? [
          ...(alertMap[_symStr.slice(0, 4)] || []),
          ...(isCB && _symStr.length > 4 ? (alertMap[_symStr] || []) : []),
        ]
      : [];
    const isAutoHit = autoReasons.length > 0;
    const showFilled = item.highlighted || isAutoHit;
    const starCls = item.highlighted ? 'on' : (isAutoHit ? 'on auto' : '');
    const starTitle = isAutoHit ? ` title="${autoReasons.join('&#10;')}"` : '';
    const starOnclick = isSummary
      ? `toggleHighlightGroup([${memberIdxs.join(',')}])`
      : `toggleHighlight(${idx})`;
    const starCell = showStar
      ? `<td><span class="star-btn ${starCls}"${starTitle} onclick="event.stopPropagation(); ${starOnclick}">${showFilled ? '★' : '☆'}</span></td>`
      : '';

    const brokerTd = `<td class="small muted">${item.broker || '—'}</td>`;

    if (isSummary) {
      return `<tr class="${rowCls}" onclick="toggleInvGroupCollapse('${escapeAttr(groupKey)}')" style="cursor:pointer;font-weight:600">
        ${starCell}${baseCells}${cbCells}${brokerTd}
        <td></td>
      </tr>`;
    }

    return `<tr class="${rowCls}" onclick="openEditPosition(${idx})" style="cursor:pointer">
      ${starCell}${baseCells}${cbCells}${brokerTd}
      <td><button class="btn-icon" onclick="event.stopPropagation(); deletePosition(${idx})">✕</button></td>
    </tr>`;
  }

  // Group consecutive rows that share the same symbol (sortedItems is already
  // sorted by symbol, so same-symbol items are adjacent) into a summary + sub-rows.
  function _buildGroupSummary(members) {
    const first = members[0];
    const sum = f => members.reduce((s, it) => s + (Number(it[f]) || 0), 0);
    const shares = sum('shares');
    const cost = sum('cost');
    const margin = sum('_margin');   // 融資借款 (0 for CB/US) — 股票均價 = (自備款+融資) / 股數
    // CB 均價 = Σ(買入均價 × 股數) / Σ股數（cost 不一定等於 entry_price×shares，故不能用 cost 反推）
    const weightedEntry = members.reduce((s, it) => s + (Number(it.entry_price) || 0) * (Number(it.shares) || 0), 0);
    const brokers = [...new Set(members.map(it => (it.broker || '').trim()).filter(Boolean))];
    return {
      symbol: first.symbol, name: first.name, note: '',
      shares, cost,
      entry_price: shares ? (isCB ? weightedEntry / shares : (cost + margin) / shares) : 0,
      current_price: first.current_price,
      _mv: sum('_mv'), _pnl: sum('_pnl'),
      _pnl_pct: cost ? sum('_pnl') / cost * 100 : 0,
      _margin: margin,
      _change_pct: first._change_pct, _stock_change_pct: first._stock_change_pct,
      broker: brokers.join(' / '),
      highlighted: members.every(it => it.highlighted),
      cb_due_date: first.cb_due_date, cbas_due_date: first.cbas_due_date,
      remain_shares: first.remain_shares, issued_shares: first.issued_shares,
      conversion_price: first.conversion_price, premium_rate: first.premium_rate,
      stock_price: first.stock_price,
      _suspended: first._suspended, _suspension_dates: first._suspension_dates,
    };
  }

  const rowsHtml = [];
  if (state.mergeSameSymbol) {
    let i = 0;
    while (i < sortedItems.length) {
      const sym = (sortedItems[i].symbol || '').trim();
      let j = i + 1;
      while (sym && j < sortedItems.length && (sortedItems[j].symbol || '').trim() === sym) j++;
      if (sym && j - i > 1) {
        const members = sortedItems.slice(i, j);
        const memberIdxs = origIdx.slice(i, j);
        const groupKey = `${state.currentInv}:${sym}`;
        rowsHtml.push(_invRowHtml(_buildGroupSummary(members), null, { isSummary: true, groupKey, memberIdxs, memberCount: members.length }));
        if (_invExpandedGroups.has(groupKey)) {
          members.forEach((item, k) => rowsHtml.push(_invRowHtml(item, memberIdxs[k], { isSub: true })));
        }
      } else {
        rowsHtml.push(_invRowHtml(sortedItems[i], origIdx[i], {}));
      }
      i = j;
    }
  } else {
    sortedItems.forEach((item, si) => rowsHtml.push(_invRowHtml(item, origIdx[si], {})));
  }
  tbody.innerHTML = rowsHtml.join('');

  // Fire async chip data fetches for all visible TW/CB symbols
  if (showStar) {
    const syms = [...new Set(
      sortedItems
        .filter(i => i.symbol)
        .map(i => isCB ? _cbToParentSym(i.symbol) : String(i.symbol).slice(0, 4))
        .filter(Boolean)
    )];
    _loadChips(syms);
  }
}

export function switchInvTab(inv) {
  state.currentInv = inv;
  document.querySelectorAll('.inv-tab').forEach(t => t.classList.toggle('active', t.dataset.inv === inv));
  renderInvestmentsPage();
}

export async function deletePosition(idx) {
  if (!confirm('確定刪除此部位？')) return;
  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  group.items.splice(idx, 1);
  await savePortfolio();
  calcTotals();
  renderInvestmentsPage();
}

export async function toggleHighlight(idx) {
  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  if (!group) return;
  group.items[idx].highlighted = !group.items[idx].highlighted;
  await savePortfolio();
  renderInvestmentsPage();
}

export async function toggleHighlightGroup(idxs) {
  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  if (!group) return;
  const allOn = idxs.every(i => group.items[i].highlighted);
  idxs.forEach(i => { group.items[i].highlighted = !allOn; });
  await savePortfolio();
  renderInvestmentsPage();
}

export function toggleMergeSameSymbol(checked) {
  state.mergeSameSymbol = checked;
  localStorage.setItem('hc_merge_same_symbol', checked ? '1' : '0');
  renderInvestmentsPage();
}

export function toggleInvGroupCollapse(groupKey) {
  if (_invExpandedGroups.has(groupKey)) _invExpandedGroups.delete(groupKey);
  else _invExpandedGroups.add(groupKey);
  renderInvestmentsPage();
}

// ══ Position modal ══════════════════════════════════════════════════════
export const _DEFAULT_BROKERS = ['永豐', '富邦', '國泰', '元大', '凱基', '玉山', '中信', '台新', '兆豐', '第一', '日盛', '群益', '統一'];

export function _brokerOptions() {
  const used = new Set();
  for (const g of (state.portfolio?.investments || [])) {
    for (const item of g.items) {
      if (item.broker) used.add(item.broker.trim());
    }
  }
  const all = [...new Set([...used, ..._DEFAULT_BROKERS.filter(b => !used.has(b))])];
  return all.map(b => `<option value="${escapeAttr(b)}">`).join('');
}

export function openAddPosition() { showPositionModal(null); }
export function openEditPosition(idx) {
  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  showPositionModal(idx, group.items[idx]);
}

export function showPositionModal(idx, item = null) {
  const isCB    = state.currentInv === 'cb';
  const isUS    = state.currentInv === 'us';
  const isStock = state.currentInv === 'stock';
  const isAdd = idx == null;
  const title = (isAdd ? '新增' : '編輯') + INV_GROUP_MAP[state.currentInv] + '部位';
  document.getElementById('modal-title').textContent = title;

  const v = (f, d = '') => item?.[f] ?? d;

  // CB fields: add mode shows minimal required fields; edit mode shows all
  let cbFields = '';
  if (isCB) {
    const autoAttr = isAdd ? 'style="opacity:.6" title="代號輸入後自動帶入"' : '';
    cbFields = `
      <h4 style="color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:18px 0 10px;">
        可轉債資訊${isAdd ? ' <span style="font-size:10px;color:var(--primary);text-transform:none;letter-spacing:0">（輸入代號後自動帶入）</span>' : ''}
      </h4>
      <div class="form-row">
        <div class="form-group"><label>CB 到期日</label><input id="f-cb-due" value="${v('cb_due_date')}" placeholder="2027/08/12" ${autoAttr}/></div>
        <div class="form-group"><label>CBAS 到期日 *</label><input id="f-cbas-due" value="${v('cbas_due_date')}" placeholder="2026/07/28" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>發行張數</label><input id="f-issued" type="text" inputmode="decimal" value="${v('issued_shares')}" ${autoAttr}/></div>
        <div class="form-group"><label>剩餘張數</label><input id="f-remain" type="text" inputmode="decimal" value="${v('remain_shares')}" ${autoAttr}/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>轉換價</label><input id="f-conv" type="text" inputmode="decimal" value="${v('conversion_price')}" ${autoAttr}/></div>
        <div class="form-group"><label>溢價率 %</label><input id="f-prem" type="text" inputmode="decimal" value="${v('premium_rate')}" ${autoAttr}/></div>
      </div>
      <div class="form-group"><label>現股價格</label><input id="f-stk" type="text" inputmode="decimal" value="${v('stock_price')}" ${autoAttr}/></div>`;
  }

  document.getElementById('modal-body').innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>代號 *（輸入後自動帶入名稱）</label>
        <input id="f-sym" value="${v('symbol')}" placeholder="${isCB ? '35871' : isUS ? 'NVDA' : '2316'}" /></div>
      <div class="form-group"><label>名稱</label>
        <input id="f-name" value="${v('name')}" placeholder="${isCB ? '或輸入名稱自動帶入代號' : isUS ? 'NVIDIA' : '楠梓電'}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>持有股數 *</label><input id="f-shares" type="text" inputmode="decimal" value="${v('shares')}" /></div>
      <div class="form-group">
        <label>買入均價 <span style="color:var(--muted);font-weight:400">（選填）</span></label>
        <input id="f-entry" type="text" inputmode="decimal" value="${v('entry_price')}" placeholder="留空由成本/股數自動計算" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>目前價格（存檔後自動更新）</label>
        <input id="f-cur" type="text" inputmode="decimal" value="${v('current_price')}" ${isCB ? 'placeholder="存檔後自動更新"' : ''} /></div>
      <div class="form-group"><label>投入成本 *</label><input id="f-cost" type="text" inputmode="decimal" value="${v('cost')}" /></div>
    </div>
    ${isStock ? `
    <div class="form-row">
      <div class="form-group">
        <label>融資金額 <span style="color:var(--muted);font-weight:400">（選填，有融資買進時填入）</span></label>
        <input id="f-margin" type="text" inputmode="decimal" value="${v('margin_amount', '')}" placeholder="0" />
      </div>
      <div class="form-group" style="padding-top:28px">
        <span class="small muted" id="f-margin-hint"></span>
      </div>
    </div>` : ''}
    ${cbFields}
    <datalist id="broker-list">
      ${_brokerOptions()}
    </datalist>
    <div class="form-row" style="margin-top:14px">
      <div class="form-group">
        <label>購入券商 <span style="color:var(--muted);font-weight:400">（選填）</span></label>
        <input id="f-broker" list="broker-list" value="${escapeAttr(v('broker'))}" placeholder="輸入或選擇..." autocomplete="off" />
      </div>
      <div class="form-group">
        <label>備註 <span style="color:var(--muted);font-weight:400">（選填，滑鼠移到名稱顯示）</span></label>
        <input id="f-note" value="${escapeAttr(v('note'))}" placeholder="例：低溢價、觀察中..." />
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="savePosition(${idx})">儲存</button>
    </div>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');

  // CB auto-lookup: symbol → name+price, or name → symbol
  if (isCB) {
    const symEl = document.getElementById('f-sym');
    const nameEl = document.getElementById('f-name');
    symEl.addEventListener('blur', () => {
      const sym = symEl.value.trim();
      if (sym) window._cbLookup('symbol', sym);
    });
    nameEl.addEventListener('blur', () => {
      const nm = nameEl.value.trim();
      if (nm) window._cbLookup('name', nm);
    });
  }

  if (!isCB) {
    const symEl  = document.getElementById('f-sym');
    const nameEl = document.getElementById('f-name');
    const curEl  = document.getElementById('f-cur');
    const market = isUS ? 'us' : 'tw';

    symEl.addEventListener('blur', async () => {
      const sym = symEl.value.trim();
      if (!sym) return;
      try {
        const data = await api('/api/stock-lookup?symbol=' + encodeURIComponent(sym) + '&market=' + market);
        if (data.name  && !nameEl.value) nameEl.value = data.name;
        if (data.price != null && !curEl.value) curEl.value = data.price;
      } catch (e) { console.warn('stock lookup failed:', e); }
    });

    // TW stocks: also support name → symbol (same logic as CB)
    if (!isUS) {
      nameEl.addEventListener('blur', async () => {
        const nm = nameEl.value.trim();
        if (!nm || symEl.value.trim()) return;
        try {
          const data = await api('/api/stock-lookup?name=' + encodeURIComponent(nm) + '&market=tw');
          if (data.symbol) symEl.value = data.symbol;
          if (data.price != null && !curEl.value) curEl.value = data.price;
        } catch (e) { console.warn('stock name lookup failed:', e); }
      });

      // Margin hint: show equity = cost - margin in real time
      const marginEl = document.getElementById('f-margin');
      const hintEl   = document.getElementById('f-margin-hint');
      if (marginEl && hintEl) {
        const updateHint = () => {
          const equity = parseFloat(document.getElementById('f-cost')?.value.replace(/,/g, '')) || 0;
          const margin = parseFloat(marginEl.value.replace(/,/g, '')) || 0;
          if (margin > 0 && equity > 0) {
            const total = equity + margin;
            const ratio = (margin / total * 100).toFixed(0);
            hintEl.textContent = `總買入 ${total.toLocaleString()} 元（融資成數 ${ratio}%）`;
            hintEl.style.color = 'var(--muted)';
          } else {
            hintEl.textContent = '';
          }
        };
        marginEl.addEventListener('input', updateHint);
        document.getElementById('f-cost')?.addEventListener('input', updateHint);
        updateHint();
      }

      // Entry price hint: auto-calculate from (cost + margin) / shares
      const updateEntryHint = () => {
        const entryEl  = document.getElementById('f-entry');
        if (!entryEl || entryEl.value.trim()) return;
        const shares = parseFloat(document.getElementById('f-shares')?.value.replace(/,/g, '')) || 0;
        const cost   = parseFloat(document.getElementById('f-cost')?.value.replace(/,/g, ''))   || 0;
        const margin = parseFloat(document.getElementById('f-margin')?.value.replace(/,/g, '')) || 0;
        if (shares > 0 && cost > 0) {
          const calc = (cost + margin) / shares;
          entryEl.placeholder = `自動計算: ${calc % 1 === 0 ? calc.toLocaleString() : calc.toFixed(2)}`;
        } else {
          entryEl.placeholder = '留空由成本/股數自動計算';
        }
      };
      ['f-shares','f-cost','f-margin'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateEntryHint);
      });
      document.getElementById('f-entry')?.addEventListener('input', () => {
        if (!document.getElementById('f-entry').value.trim())
          updateEntryHint();
        else
          document.getElementById('f-entry').placeholder = '留空由成本/股數自動計算';
      });
      updateEntryHint();
    }
  }

  // Entry hint for US / CB (no margin field)
  if (isUS || isCB) {
    const updateEntryHint = () => {
      const entryEl = document.getElementById('f-entry');
      if (!entryEl || entryEl.value.trim()) return;
      const shares = parseFloat(document.getElementById('f-shares')?.value.replace(/,/g, '')) || 0;
      const cost   = parseFloat(document.getElementById('f-cost')?.value.replace(/,/g, ''))   || 0;
      if (shares > 0 && cost > 0) {
        const calc = cost / shares;
        entryEl.placeholder = `自動計算: ${calc % 1 === 0 ? calc.toLocaleString() : calc.toFixed(2)}`;
      } else {
        entryEl.placeholder = '留空由成本/股數自動計算';
      }
    };
    ['f-shares', 'f-cost'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', updateEntryHint);
    });
    updateEntryHint();
  }
}

window._cbLookup = async function(field, value) {
  try {
    const data = await api('/api/cb-lookup?' + field + '=' + encodeURIComponent(value));
    if (!document.getElementById('f-sym')) return; // modal closed

    // Always overwrite text fields (sym/name); only fill numeric if currently empty
    const fillText = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null && val !== '') el.value = val;
    };
    const fillNum = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null && (!el.value || el.value === '0')) el.value = val;
    };

    if (data.symbol) fillText('f-sym',  data.symbol);
    if (data.name)   fillText('f-name', data.name);
    fillNum('f-cur',    data.price);
    fillText('f-cb-due',  data.cb_due_date);
    fillNum('f-issued',   data.issued_shares);
    fillNum('f-remain',   data.remain_shares);
    fillNum('f-conv',     data.conversion_price);
    fillNum('f-prem',     data.premium_rate);
    fillNum('f-stk',      data.stock_price);
  } catch (e) { console.warn('cb lookup failed:', e); }
};

export async function savePosition(idx) {
  const isCB    = state.currentInv === 'cb';
  const isStock = state.currentInv === 'stock';
  const groupName = INV_GROUP_MAP[state.currentInv];
  let group = state.portfolio.investments.find(g => g.group === groupName);
  if (!group) {
    group = { group: groupName, items: [] };
    state.portfolio.investments.push(group);
  }

  const val = id => document.getElementById(id)?.value ?? '';
  const num = id => parseFloat(val(id)) || 0;

  const sym = val('f-sym').trim();
  let nameVal = val('f-name').trim();
  // If name still empty after auto-fill (user saved too fast), try CBAS cache
  if (!nameVal && sym && isCB) {
    try {
      const cached = await api('/api/cb-lookup?symbol=' + encodeURIComponent(sym));
      if (cached.name) nameVal = cached.name;
    } catch (_) {}
  }

  const shares    = num('f-shares');
  const cost      = num('f-cost');
  const marginAmt = isStock ? (num('f-margin') || 0) : 0;
  let entryPrice  = num('f-entry');
  if (!entryPrice && shares > 0 && cost > 0) {
    entryPrice = (cost + marginAmt) / shares;
  }

  const data = {
    symbol: sym,
    name: nameVal,
    shares,
    entry_price: entryPrice,
    current_price: num('f-cur'),
    cost,
    broker: val('f-broker').trim() || undefined,
    note: val('f-note').trim() || undefined,
    ...(isStock ? { margin_amount: marginAmt } : {}),
  };

  if (isCB) {
    Object.assign(data, {
      cb_due_date: val('f-cb-due') || (idx != null ? (group.items[idx]?.cb_due_date || '') : ''),
      cbas_due_date: val('f-cbas-due'),
      issued_shares: num('f-issued') || (idx != null ? (group.items[idx]?.issued_shares || 0) : 0),
      remain_shares: num('f-remain') || (idx != null ? (group.items[idx]?.remain_shares || 0) : 0),
      conversion_price: num('f-conv') || (idx != null ? (group.items[idx]?.conversion_price || 0) : 0),
      premium_rate: num('f-prem') || (idx != null ? (group.items[idx]?.premium_rate || 0) : 0),
      stock_price: num('f-stk') || (idx != null ? (group.items[idx]?.stock_price || 0) : 0),
    });
  }

  if (idx == null) {
    group.items.push(data);
  } else {
    Object.assign(group.items[idx], data);
  }

  await savePortfolio();
  closeModal();
  calcTotals();
  renderInvestmentsPage();
  if (currentPage() === 'dashboard') renderDashboard();
  toast('已儲存');
}
