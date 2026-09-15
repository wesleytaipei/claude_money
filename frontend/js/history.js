// 歷史紀錄 + 資料管理 (manual history / history.json editor) pages.

import { api, loadHistory, loadManualHistory } from './api.js';
import { closeModal, openModal } from './routing.js';
import { charts, state } from './state.js';
import { fmtFull, toast } from './utils.js';

// ══ History Page ════════════════════════════════════════════════════════
export function renderHistoryPage() {
  const list = state.manualHistory;
  document.getElementById('hist-count').textContent = `${list.length} 筆紀錄`;

  document.getElementById('hist-list').innerHTML = list.length === 0
    ? '<div class="empty-state">尚無歷史資料</div>'
    : [...list].reverse().map(h => `
        <div class="hist-item">
          <span class="hist-date">${h.date}</span>
          <span class="hist-val">${fmtFull(h.net_worth)}</span>
          <button class="btn-icon" onclick="deleteManualHistory('${h.date}')">✕</button>
        </div>
      `).join('');

  // Chart
  if (list.length < 2) return;
  const labels = list.map(r => r.date);
  const nwData = list.map(r => r.net_worth);

  const ctx = document.getElementById('hist-chart').getContext('2d');
  if (charts.hist) charts.hist.destroy();

  charts.hist = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '淨資產 (TWD)',
        data: nwData,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,.15)',
        borderWidth: 3,
        tension: 0.3,
        fill: true,
        pointRadius: 3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#e8ecf6' } },
        tooltip: {
          backgroundColor: '#1a2547',
          borderColor: '#334b82',
          borderWidth: 1,
          callbacks: { label: c => ` ${fmtFull(c.raw)}` }
        }
      },
      scales: {
        x: { ticks: { color: '#a7b0c8', maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,.04)' } },
        y: { ticks: { color: '#a7b0c8', callback: v => (v / 1e6).toFixed(0) + 'M' }, grid: { color: 'rgba(255,255,255,.06)' } }
      }
    }
  });
}

export async function addManualHistory() {
  const date = document.getElementById('hist-date').value;
  const nw = parseFloat(document.getElementById('hist-nw').value) || 0;
  const taiex = parseFloat(document.getElementById('hist-taiex').value) || 0;
  const otc = parseFloat(document.getElementById('hist-otc').value) || 0;
  if (!date || !nw) { toast('請輸入日期和淨資產', 'error'); return; }

  await api('/api/manual-history', {
    method: 'POST',
    body: JSON.stringify({ date, net_worth: nw, taiex, otc })
  });
  await loadManualHistory();
  renderHistoryPage();
  toast('✅ 已新增');
}

export async function deleteManualHistory(date) {
  if (!confirm(`刪除 ${date} 的紀錄？`)) return;
  await api('/api/manual-history/' + date, { method: 'DELETE' });
  await loadManualHistory();
  renderHistoryPage();
}

// ══ 資料管理 (history.json CRUD) ══════════════════════════════════════════
export function renderDataEditorPage() {
  const dates = Object.keys(state.history || {})
    .filter(d => d !== '_last_modified')
    .sort().reverse();

  document.getElementById('data-editor-count').textContent = `${dates.length} 筆紀錄`;

  document.getElementById('data-editor-tbody').innerHTML = dates.length === 0
    ? '<tr><td colspan="10" style="text-align:center; padding:20px;">尚無資料</td></tr>'
    : dates.map(d => {
        const h = state.history[d];
        return `
          <tr>
            <td>${d}</td>
            <td>${fmtFull(h.net_worth)}</td>
            <td>${fmtFull(h.total_assets)}</td>
            <td>${fmtFull(h.total_liabilities)}</td>
            <td>${h.taiex ?? '—'}</td>
            <td>${h.otc ?? '—'}</td>
            <td>${h.dji ?? '—'}</td>
            <td>${h.nasdaq ?? '—'}</td>
            <td>${h.sox ?? '—'}</td>
            <td style="white-space:nowrap">
              <button class="btn-ghost" style="padding:3px 8px;font-size:11px" onclick="openHistoryEntryModal('${d}')">✏️</button>
              <button class="btn-icon" onclick="deleteHistoryEntry('${d}')">✕</button>
            </td>
          </tr>`;
      }).join('');
}

export let _histEditGroups = [];   // [{name, value}] rows while the modal is open
export let _histEditIsNew = true;

export function openHistoryEntryModal(date) {
  const h = date ? (state.history[date] || {}) : {};
  _histEditIsNew = !date;
  _histEditGroups = Object.entries(h.asset_groups || {}).map(([name, value]) => ({ name, value }));

  openModal(date ? `✏️ 編輯 ${date}` : '➕ 新增紀錄', `
    <div class="form-group">
      <label>日期</label>
      <input type="date" id="he-date" value="${date || ''}" ${date ? 'disabled' : ''} />
    </div>
    <div class="form-row">
      <div class="form-group"><label>淨資產</label>
        <input type="text" inputmode="decimal" id="he-nw" value="${h.net_worth ?? ''}" /></div>
      <div class="form-group"><label>總資產</label>
        <input type="text" inputmode="decimal" id="he-ta" value="${h.total_assets ?? ''}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>總負債</label>
        <input type="text" inputmode="decimal" id="he-tl" value="${h.total_liabilities ?? ''}" /></div>
      <div></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>加權指數</label>
        <input type="text" inputmode="decimal" id="he-taiex" value="${h.taiex ?? ''}" /></div>
      <div class="form-group"><label>櫃買指數</label>
        <input type="text" inputmode="decimal" id="he-otc" value="${h.otc ?? ''}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>道瓊</label>
        <input type="text" inputmode="decimal" id="he-dji" value="${h.dji ?? ''}" /></div>
      <div class="form-group"><label>那斯達克</label>
        <input type="text" inputmode="decimal" id="he-nasdaq" value="${h.nasdaq ?? ''}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>費城半導體</label>
        <input type="text" inputmode="decimal" id="he-sox" value="${h.sox ?? ''}" /></div>
      <div></div>
    </div>

    <div class="form-group">
      <label>資產分類明細 (asset_groups)</label>
      <div id="he-groups-rows"></div>
      <button class="btn-ghost" style="margin-top:6px;font-size:12px" onclick="_histAddGroupRow()">＋ 新增分類</button>
    </div>

    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="saveHistoryEntry('${date || ''}')">儲存</button>
    </div>`);

  _histRenderGroupRows();
}

export function _histRenderGroupRows() {
  const el = document.getElementById('he-groups-rows');
  if (!el) return;
  el.innerHTML = _histEditGroups.map((g, i) => `
    <div class="form-row" style="grid-template-columns:1fr 1fr auto;align-items:center;gap:8px">
      <input type="text" placeholder="分類名稱" value="${g.name}" oninput="_histEditGroups[${i}].name=this.value" />
      <input type="text" inputmode="decimal" placeholder="金額" value="${g.value}" oninput="_histEditGroups[${i}].value=this.value" />
      <button class="btn-icon" onclick="_histRemoveGroupRow(${i})">✕</button>
    </div>`).join('');
}

export function _histAddGroupRow() {
  _histEditGroups.push({ name: '', value: 0 });
  _histRenderGroupRows();
}

export function _histRemoveGroupRow(i) {
  _histEditGroups.splice(i, 1);
  _histRenderGroupRows();
}

export async function saveHistoryEntry(origDate) {
  const date = _histEditIsNew ? document.getElementById('he-date').value : origDate;
  if (!date) { toast('請選擇日期', 'error'); return; }

  const num = id => {
    const v = document.getElementById(id).value;
    return v === '' ? undefined : parseFloat(v);
  };

  const asset_groups = {};
  for (const g of _histEditGroups) {
    const name = (g.name || '').trim();
    if (!name) continue;
    asset_groups[name] = parseFloat(g.value) || 0;
  }

  const body = {
    date,
    net_worth: num('he-nw') ?? 0,
    total_assets: num('he-ta') ?? 0,
    total_liabilities: num('he-tl') ?? 0,
    asset_groups,
    taiex: num('he-taiex'),
    otc: num('he-otc'),
    dji: num('he-dji'),
    nasdaq: num('he-nasdaq'),
    sox: num('he-sox'),
  };
  // Drop undefined index fields instead of writing them as null
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  try {
    await api('/api/snapshot', { method: 'POST', body: JSON.stringify(body) });
    await loadHistory();
    closeModal();
    renderDataEditorPage();
    toast('✅ 已儲存');
  } catch (e) {
    toast('儲存失敗：' + e.message, 'error');
  }
}

export async function deleteHistoryEntry(date) {
  if (!confirm(`刪除 ${date} 的快照紀錄？此操作無法復原（可用「回溯」還原）。`)) return;
  try {
    await api('/api/history/' + date, { method: 'DELETE' });
    await loadHistory();
    renderDataEditorPage();
    toast('✅ 已刪除');
  } catch (e) {
    toast('刪除失敗：' + e.message, 'error');
  }
}
