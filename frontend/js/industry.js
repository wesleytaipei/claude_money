// 產業地圖 page.

import { api } from './api.js';
import { closeModal, currentPage, openModal } from './routing.js';
import { API, state } from './state.js';
import { fmt, toast } from './utils.js';

// ══ 產業地圖 ════════════════════════════════════════════════════════════════
export let _indData = null;   // last fetched API response

export const _IND_MARKETS = [
  {value:'TW_AUTO', label:'🇹🇼 台灣（自動判斷上市/上櫃）'},
  {value:'JP',      label:'🇯🇵 日本 (TSE)'},
  {value:'KR',      label:'🇰🇷 韓國 (KRX)'},
  {value:'US',      label:'🇺🇸 美國 (NYSE/NASDAQ)'},
  {value:'DE',      label:'🇩🇪 德國 (FWB/XETRA)'},
  {value:'UK',      label:'🇬🇧 英國 (LSE)'},
  {value:'PA',      label:'🇫🇷 法國 (Euronext Paris)'},
  {value:'CN_SZ',   label:'🇨🇳 中國深圳 (SZ)'},
  {value:'CN_SS',   label:'🇨🇳 中國上海 (SS)'},
  {value:'HK',      label:'🇭🇰 香港 (HKEX)'},
];
export const _IND_MARKET_ORDER = ['TW_AUTO','TW','TWO','JP','KR','US','DE','UK','PA','HK','CN_SZ','CN_SS'];
export const _IND_MARKET_META = {
  TW_AUTO:{flag:'🇹🇼',currency:'TWD'}, TW:{flag:'🇹🇼',currency:'TWD'}, TWO:{flag:'🇹🇼',currency:'TWD'},
  JP:{flag:'🇯🇵',currency:'JPY'}, KR:{flag:'🇰🇷',currency:'KRW'}, US:{flag:'🇺🇸',currency:'USD'},
  DE:{flag:'🇩🇪',currency:'EUR'}, UK:{flag:'🇬🇧',currency:'GBP'}, PA:{flag:'🇫🇷',currency:'EUR'},
  CN_SZ:{flag:'🇨🇳',currency:'CNY'}, CN_SS:{flag:'🇨🇳',currency:'CNY'}, HK:{flag:'🇭🇰',currency:'HKD'},
};
export const _IND_SORT_ORDER = ['TW','JP','KR','US','DE','UK','PA','HK','CN_SZ','CN_SS'];
export function _mktSortKey(m) {
  if (!m) return 'ZZ';
  if (m === 'TW_AUTO' || m === 'TW' || m === 'TWO') return 'TW';
  return m;
}
export function _sortIndStocks(stocks) {
  return [...stocks].sort((a, b) => {
    const oa = _IND_SORT_ORDER.indexOf(_mktSortKey(a.market));
    const ob = _IND_SORT_ORDER.indexOf(_mktSortKey(b.market));
    if (oa !== ob) return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
    const na = parseInt(a.code, 10), nb = parseInt(b.code, 10);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.code.localeCompare(b.code);
  });
}

export const _IND_CURRENCY_FMT = {
  JPY: p => Math.round(p).toLocaleString(),
  KRW: p => Math.round(p).toLocaleString(),
  GBX: p => Math.round(p).toLocaleString(),
  USD: p => p.toFixed(2),
  CNY: p => p.toFixed(2),
  HKD: p => p.toFixed(2),
  TWD: p => p.toFixed(2),
  EUR: p => p.toFixed(2),
  GBP: p => p.toFixed(2),
};
export const _IND_CURRENCY_PREFIX = {TWD:'',JPY:'¥',USD:'$',KRW:'₩',CNY:'¥',HKD:'HK$',EUR:'€',GBP:'£',GBX:'p'};

export function _fmtIndPrice(price, currency) {
  if (price == null || !isFinite(price)) return '—';
  const fmt = _IND_CURRENCY_FMT[currency] || (p => p.toFixed(2));
  const pre = _IND_CURRENCY_PREFIX[currency] ?? '';
  return pre + fmt(price);
}

export async function renderIndustryMap(force = false) {
  const body = document.getElementById('industry-body');
  if (!body) return;
  if (!_indData) body.innerHTML = '<div class="empty-state">⏳ 載入中…</div>';
  try {
    _indData = await api(`/api/industry-map${force ? '?force=true' : ''}`);
    _renderIndGroups();
    const sub = document.getElementById('industry-sub');
    if (sub && _indData.updated_at) {
      const d = new Date(_indData.updated_at);
      const staleTag = _indData.stale ? ' ⟳' : '';
      sub.textContent = `更新於 ${d.toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'})}${staleTag}`;
    }
    // Stale-while-revalidate: backend is refreshing in background; re-fetch after 5s
    if (_indData.stale) setTimeout(_bgRefreshIndPrices, 5000);
  } catch(e) {
    body.innerHTML = `<div class="empty-state">載入失敗：${e.message}</div>`;
  }
}

// ── Auto-refresh while the page stays open (server-side cache makes this cheap) ──
export let _indAutoRefreshTimer = null;

export function _startIndustryAutoRefresh() {
  if (_indAutoRefreshTimer) return;
  _indAutoRefreshTimer = setInterval(() => {
    if (!document.hidden) renderIndustryMap(false);
  }, 60000);
}

export function _stopIndustryAutoRefresh() {
  if (_indAutoRefreshTimer) { clearInterval(_indAutoRefreshTimer); _indAutoRefreshTimer = null; }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentPage() === 'industry') renderIndustryMap(false);
});

export function _renderIndGroups() {
  const body = document.getElementById('industry-body');
  if (!body || !_indData) return;
  const { groups } = _indData;
  if (!groups || !groups.length) {
    body.innerHTML = '<div class="empty-state">尚無族群，點擊「＋ 新增族群」開始</div>';
    return;
  }
  groups.forEach(g => { if (g.stocks) g.stocks = _sortIndStocks(g.stocks); });
  body.innerHTML = groups.map((g, gi) => _renderIndGroupCard(g, gi)).join('');
}

export function _renderIndGroupCard(g, gi) {
  const rows = (g.stocks || []).map((s, si) => {
    const up = (s.change_pct ?? 0) >= 0;
    const clr = s.ok ? (up ? 'var(--red-2)' : 'var(--green-2)') : 'var(--muted)';
    const pStr = s.ok ? _fmtIndPrice(s.price, s.currency) : '—';
    const cStr = s.ok ? `${up ? '+' : ''}${s.change_pct?.toFixed(2)}%` : '—';
    return `<tr>
      <td class="ind-flag-code">${s.flag || ''}<span class="ind-code">${s.code}</span></td>
      <td class="ind-name">${s.name}</td>
      <td class="num ind-price" style="color:${clr}">${pStr}</td>
      <td class="num ind-chg"   style="color:${clr}">${cStr}</td>
      <td><button class="btn-icon ind-del" onclick="deleteIndStock(${gi},${si})" title="移除">✕</button></td>
    </tr>`;
  }).join('');

  return `<div class="panel ind-group" id="ind-group-${gi}">
    <div class="panel-head">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:18px;line-height:1">${g.icon || '📊'}</span>
        <h3 style="font-size:14px">${g.name}</h3>
        <span class="panel-sub">${(g.stocks||[]).length} 檔</span>
      </div>
      <div style="display:flex;gap:4px">
        <button class="btn-primary ind-add-btn" onclick="openAddIndStock(${gi})">＋ 個股</button>
        <button class="btn-icon" onclick="deleteIndGroup(${gi})" title="刪除族群">✕</button>
      </div>
    </div>
    <div class="table-wrap ind-group-stocks">
      <table><tbody>
        ${rows || '<tr><td colspan="5" class="muted" style="text-align:center;padding:10px">尚無個股</td></tr>'}
      </tbody></table>
    </div>
  </div>`;
}

// ── CRUD helpers ─────────────────────────────────────────────────────────────
export function _indConfigFromData() {
  return {
    groups: (_indData?.groups || []).map(g => ({
      id: g.id || g.name,
      name: g.name,
      icon: g.icon || '📊',
      stocks: (g.stocks || []).map(s => ({code: s.code, name: s.name, market: s.market})),
    }))
  };
}

export function _reRenderIndGroup(gi) {
  const el = document.getElementById(`ind-group-${gi}`);
  if (!el) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = _renderIndGroupCard(_indData.groups[gi], gi);
  el.replaceWith(tmp.firstChild);
}

export function _putIndConfig() {
  return fetch('/api/industry-map/config', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(_indConfigFromData()),
  });
}

export function _bgRefreshIndPrices() {
  // Silently refresh all stock prices after save — no spinner
  fetch('/api/industry-map?force=true')
    .then(r => r.json())
    .then(data => { _indData = data; _renderIndGroups(); })
    .catch(() => {});
}


export function openAddIndustryGroup() {
  const mktOpts = _IND_MARKETS.map(m =>
    `<option value="${m.value}">${m.label}</option>`).join('');
  openModal('新增族群', `
    <div class="form-group"><label>族群名稱</label>
      <input id="ig-name" type="text" placeholder="如：AI 伺服器" /></div>
    <div class="form-group"><label>圖示（emoji）</label>
      <input id="ig-icon" type="text" placeholder="📊" maxlength="4" value="📊" /></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="_addIndGroup()">新增</button>
    </div>`);
}

export async function _addIndGroup() {
  const name = document.getElementById('ig-name')?.value.trim();
  const icon = document.getElementById('ig-icon')?.value.trim() || '📊';
  if (!name) { toast('請輸入族群名稱', 'error'); return; }
  if (!_indData) _indData = {groups: []};
  _indData.groups.push({id: Date.now().toString(), name, icon, stocks: []});
  closeModal();
  _renderIndGroups();
  _putIndConfig().catch(() => {});
}

export function openAddIndStock(gi) {
  const mktOpts = _IND_MARKETS.map(m =>
    `<option value="${m.value}">${m.label}</option>`).join('');
  openModal('新增個股', `
    <div class="form-group"><label>市場</label>
      <select id="is-market">${mktOpts}</select></div>
    <div class="form-group"><label>代號</label>
      <input id="is-code" type="text" placeholder="如：2327 / 6981 / VSH" /></div>
    <div class="form-group"><label>名稱</label>
      <input id="is-name" type="text" placeholder="如：國巨" /></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="_addIndStock(${gi})">新增</button>
    </div>`);
}

export async function _addIndStock(gi) {
  const market = document.getElementById('is-market')?.value || 'TW_AUTO';
  const code   = document.getElementById('is-code')?.value.trim().toUpperCase();
  const name   = document.getElementById('is-name')?.value.trim();
  if (!code || !name) { toast('請填寫代號與名稱', 'error'); return; }
  const meta = _IND_MARKET_META[market] || _IND_MARKET_META['US'];
  // Optimistic: add with placeholder price, sort immediately
  _indData.groups[gi].stocks.push({code, name, market, flag: meta.flag, currency: meta.currency, ok: false});
  _indData.groups[gi].stocks = _sortIndStocks(_indData.groups[gi].stocks);
  closeModal();
  _reRenderIndGroup(gi);
  // Save config, then silently refresh prices for this group
  _putIndConfig().then(_bgRefreshIndPrices).catch(() => {});
}

export async function deleteIndStock(gi, si) {
  if (!confirm('確定移除此個股？')) return;
  _indData.groups[gi].stocks.splice(si, 1);
  _reRenderIndGroup(gi);
  _putIndConfig().catch(() => {});
}

export async function deleteIndGroup(gi) {
  const name = _indData?.groups[gi]?.name || '';
  if (!confirm(`確定刪除族群「${name}」及其所有個股？`)) return;
  _indData.groups.splice(gi, 1);
  _renderIndGroups();
  _putIndConfig().catch(() => {});
}
