// 資產與負債 (assets/liabilities) page.

import { savePortfolio } from './api.js';
import { renderDashboard } from './dashboard.js';
import { currentPage } from './routing.js';
import { state } from './state.js';
import { escapeAttr, fmt, fmtFull, toTWD } from './utils.js';

// ══ Render: Assets & Liabilities ════════════════════════════════════════
export function renderAssetsPage() {
  document.getElementById('fx-usd').textContent = state.usdTwd.toFixed(3);
  document.getElementById('fx-jpy').textContent = state.jpyTwd.toFixed(4);
  _renderAllGroups('assets-groups',      'assets');
  _renderAllGroups('liabilities-groups', 'liabilities');
}

export function _renderAllGroups(containerId, section) {
  const groups    = state.portfolio[section] || [];
  const container = document.getElementById(containerId);
  const isLiab    = section === 'liabilities';

  if (groups.length === 0) {
    container.innerHTML = '<div class="empty-state">尚無群組，點擊「＋ 新增群組」開始</div>';
    return;
  }

  const renderCol = (g, gi) => {
    const total = g.items.reduce((s, it) => s + toTWD(Number(it.amount) || 0, it.currency), 0);
    const rows  = g.items.map((item, ii) => renderItemRow(section, gi, ii, item, isLiab)).join('');
    const hdrRight = isLiab ? '餘額 / 利率' : '金額 / 幣別';
    return `<div class="alm-col">
      <div class="alm-col-head">
        <span class="alm-col-title">${g.group}</span>
        <span class="alm-col-total ${total >= 0 ? '' : 'red'}">${fmt(total)}</span>
      </div>
      <div class="alm-col-hdr"><span>名稱</span><span>${hdrRight}</span><span>台幣</span></div>
      <div class="group-body">${rows || '<div class="empty-state" style="padding:10px 14px">無項目</div>'}</div>
      <div class="alm-col-footer">
        <button class="btn-primary" onclick="addItemToGroup('${section}',${gi})">＋ 項目</button>
        <button class="btn-icon" onclick="deleteGroup('${section}',${gi})">✕</button>
      </div>
    </div>`;
  };

  if (!isLiab && groups.length > 1) {
    // 資產：第一組獨立左欄，其餘堆疊在右欄
    const left  = renderCol(groups[0], 0);
    const right = groups.slice(1).map((g, i) => renderCol(g, i + 1)).join('');
    container.innerHTML = `
      <div class="alm-cols" style="grid-template-columns:1fr 1fr">
        ${left}
        <div class="alm-stack">${right}</div>
      </div>`;
  } else {
    // 負債：全部垂直堆疊
    container.innerHTML = `<div class="alm-stack">${groups.map((g, gi) => renderCol(g, gi)).join('')}</div>`;
  }
}

export function renderGroupList(section, containerId) {
  const groups = state.portfolio[section] || [];
  const container = document.getElementById(containerId);
  const isLiab = section === 'liabilities';

  if (groups.length === 0) {
    container.innerHTML = '<div class="empty-state">尚無群組，點擊「＋ 新增群組」開始</div>';
    return;
  }

  container.innerHTML = groups.map((g, gi) => {
    const total = g.items.reduce((s, it) => s + toTWD(Number(it.amount) || 0, it.currency), 0);
    const rows = g.items.map((item, ii) => renderItemRow(section, gi, ii, item, isLiab)).join('');
    return `
      <div class="group-block">
        <div class="group-header">
          <div class="group-title">
            ${g.group}
            <span class="group-badge">${g.items.length} 項</span>
          </div>
          <div style="display:flex; align-items:center; gap:14px;">
            <div class="group-total ${total >= 0 ? '' : 'red'}">${fmtFull(total)}</div>
            <div class="group-actions">
              <button class="btn-primary" onclick="addItemToGroup('${section}', ${gi})">＋ 項目</button>
              <button class="btn-icon" onclick="deleteGroup('${section}', ${gi})">✕</button>
            </div>
          </div>
        </div>
        <div class="group-body">${rows}</div>
      </div>
    `;
  }).join('');
}

export function renderItemRow(section, gi, ii, item, isLiab) {
  const curOpts = ['TWD', 'USD', 'JPY'].map(c =>
    `<option value="${c}" ${item.currency === c ? 'selected' : ''}>${c}</option>`).join('');
  const twd    = toTWD(Number(item.amount) || 0, item.currency);
  const twdCls = `alm-twd${isLiab ? ' red' : ''} priv-amt`;
  const cur    = item.currency || 'TWD';
  // amount display: show in original currency
  const amtFmt = cur === 'TWD' ? Math.round(item.amount ?? 0).toLocaleString()
               : cur === 'USD' ? 'US$' + Number(item.amount ?? 0).toLocaleString('en', {minimumFractionDigits:2, maximumFractionDigits:2})
               : '¥'  + Math.round(item.amount ?? 0).toLocaleString();

  if (isLiab && item._auto_margin) {
    return `<div class="alm-item" style="opacity:.75">
      <div class="alm-item-top">
        <span class="alm-iname-dis" style="color:var(--primary-2);flex:1">${escapeAttr(item.name||'')}</span>
        <span class="${twdCls}">${fmt(twd)}</span>
        <button class="btn-icon" style="cursor:default;opacity:.4" title="由股票融資自動計算">🔒</button>
      </div>
      <div class="alm-item-bot"><span class="alm-amt-dis">${amtFmt}</span><span class="alm-cur-tag">${cur}</span></div>
    </div>`;
  }

  if (!isLiab) {
    return `<div class="alm-item">
      <div class="alm-item-top">
        <input class="alm-iname" value="${escapeAttr(item.name||'')}" placeholder="名稱"
               onchange="updateItem('${section}',${gi},${ii},'name',this.value)"/>
        <span class="${twdCls}">${fmt(twd)}</span>
        <button class="btn-icon" onclick="deleteItem('${section}',${gi},${ii})">✕</button>
      </div>
      <div class="alm-item-bot">
        <input class="alm-iamt num-input priv-num" type="text" inputmode="decimal" value="${item.amount??0}"
               onchange="updateItem('${section}',${gi},${ii},'amount',parseFloat(this.value)||0)"/>
        <select class="alm-icur" onchange="updateItemCurrency('${section}',${gi},${ii},this.value)">${curOpts}</select>
      </div>
    </div>`;
  }

  return `<div class="alm-item">
    <div class="alm-item-top">
      <input class="alm-iname" value="${escapeAttr(item.name||'')}" placeholder="名稱"
             onchange="updateItem('${section}',${gi},${ii},'name',this.value)"/>
      <span class="${twdCls}">${fmt(twd)}</span>
      <button class="btn-icon" onclick="deleteItem('${section}',${gi},${ii})">✕</button>
    </div>
    <div class="alm-item-bot">
      <input class="alm-iamt num-input priv-num" type="text" inputmode="decimal" value="${item.amount??0}"
             onchange="updateItem('${section}',${gi},${ii},'amount',parseFloat(this.value)||0)"/>
      <select class="alm-icur" onchange="updateItemCurrency('${section}',${gi},${ii},this.value)">${curOpts}</select>
      <span class="alm-sep">·</span>
      <span class="alm-sub-lbl">利率 <input type="text" inputmode="decimal" value="${item.rate_pct??''}" placeholder="—"
            onchange="updateItem('${section}',${gi},${ii},'rate_pct',parseFloat(this.value)||0)"/>%</span>
      <span class="alm-sub-lbl"><input type="text" value="${escapeAttr(item.start_date||'')}" placeholder="YYYY/MM"
            onchange="updateItem('${section}',${gi},${ii},'start_date',this.value)"/> 起</span>
      <span class="alm-sub-lbl"><input type="text" inputmode="decimal" value="${item.years??''}" placeholder="—"
            onchange="updateItem('${section}',${gi},${ii},'years',parseFloat(this.value)||0)"/> 期</span>
    </div>
  </div>`;
}


// ══ CRUD: assets/liabilities items ══════════════════════════════════════
export async function updateItem(section, gi, ii, field, value) {
  state.portfolio[section][gi].items[ii][field] = value;
  recalcValue(state.portfolio[section][gi].items[ii]);
  await savePortfolio();
  renderAssetsPage();
  if (currentPage() === 'dashboard') renderDashboard();
}

export async function updateItemCurrency(section, gi, ii, currency) {
  const item = state.portfolio[section][gi].items[ii];
  item.currency = currency;
  if (currency === 'TWD') item.rate = 1;
  else if (currency === 'USD') item.rate = state.usdTwd;
  else if (currency === 'JPY') item.rate = state.jpyTwd;
  recalcValue(item);
  await savePortfolio();
  renderAssetsPage();
}

export function recalcValue(item) {
  const amt = Number(item.amount) || 0;
  const rate = Number(item.rate) || 1;
  item.value = amt * rate;
}

export async function deleteItem(section, gi, ii) {
  if (!confirm('確定刪除此項目？')) return;
  state.portfolio[section][gi].items.splice(ii, 1);
  await savePortfolio();
  renderAssetsPage();
}

export async function deleteGroup(section, gi) {
  const g = state.portfolio[section][gi];
  if (!confirm(`確定刪除群組「${g.group}」及其 ${g.items.length} 個項目？`)) return;
  const wasActive = section === 'assets' ? state.currentAssetTab === g.group
                                         : state.currentLiabTab === g.group;
  state.portfolio[section].splice(gi, 1);
  if (wasActive) {
    const first = state.portfolio[section][0]?.group ?? null;
    if (section === 'assets') state.currentAssetTab = first;
    else state.currentLiabTab = first;
  }
  await savePortfolio();
  renderAssetsPage();
}

export function addItemToGroup(section, gi) {
  state.portfolio[section][gi].items.push({
    name: '新項目', amount: 0, currency: 'TWD', rate: 1, value: 0,
    ...(section === 'liabilities' ? { rate_pct: 0, start_date: '', years: 0 } : {})
  });
  savePortfolio();
  renderAssetsPage();
}

export function openAddGroup(section) {
  const name = prompt(`新群組名稱：`);
  if (!name) return;
  state.portfolio[section].push({ group: name, items: [] });
  if (section === 'assets') state.currentAssetTab = name;
  else state.currentLiabTab = name;
  savePortfolio();
  renderAssetsPage();
}
