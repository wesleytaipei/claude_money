// ETF追蹤 page (detail view + 重點關注 focus view).

import { api } from './api.js';
import { state } from './state.js';
import { fmtPct, fmtPrice } from './utils.js';

// ══ ETF追蹤 ════════════════════════════════════════════════════════════════

/** Format a price-change % with 漲停/跌停 background highlight (matches cell-limit-up/down CSS). */
export function _fmtPctLimit(v) {
  if (v == null) return '<span class="muted">—</span>';
  const isUp = v >= 9.8, isDn = v <= -9.8;
  const sign = v > 0 ? '+' : '';
  const txt  = `${sign}${Number(v).toFixed(2)}%`;
  if (isUp)
    return `<span style="background:rgba(220,38,38,.20);color:#fb7185;font-weight:700;
                         padding:2px 6px;border-radius:4px;display:inline-block">${txt}</span>`;
  if (isDn)
    return `<span style="background:rgba(16,185,129,.15);color:#34d399;font-weight:700;
                         padding:2px 6px;border-radius:4px;display:inline-block">${txt}</span>`;
  const color = v > 0 ? 'var(--red)' : 'var(--green)';
  return `<span style="color:${color}">${txt}</span>`;
}

export const _etfState = {
  code: '00981A', list: [], cache: {},
  filterOps: new Set(),   // empty = 全部
  filterTop: 0,
  sort: 'op',             // 'op'|'weight_desc'|'weight_asc'|'price_desc'|'price_asc'|'shares_desc'|'shares_asc'
  view: 'focus',          // 'focus' | 'detail'
};

export const _etfFocusCodes = ['00981A', '00403A', '00991A', '00992A'];

export async function renderEtfPage(force = false) {
  const body  = document.getElementById('etf-body');
  const subEl = document.getElementById('etf-sub');
  const tabBar = document.getElementById('etf-tab-bar');
  if (!body) return;

  // Load ETF list once (now returns [{code, name}])
  if (_etfState.list.length === 0) {
    try {
      const listRes = await api('/api/etf-list');
      if (listRes.etfs?.length) _etfState.list = listRes.etfs;
    } catch (_) {}
    if (_etfState.list.length === 0) _etfState.list = [{ code: '00981A', name: '00981A 主動統一台股增長' }];
  }

  // Render tab bar (ETF tabs left, view toggle right)
  if (tabBar) {
    const isFocus = _etfState.view === 'focus';
    const etfTabs = !isFocus ? _etfState.list.map(e => `
      <button onclick="_etfSwitchTab('${e.code}')"
        style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
               border:1px solid ${e.code === _etfState.code ? 'var(--primary-2)' : 'rgba(148,163,184,.3)'};
               background:${e.code === _etfState.code ? 'rgba(99,102,241,.15)' : 'transparent'};
               color:${e.code === _etfState.code ? 'var(--primary-2)' : 'var(--text-muted)'}">
        ${e.code}
      </button>`).join('') : '';
    tabBar.innerHTML = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <div style="display:flex;gap:6px;flex-wrap:wrap">${etfTabs}</div>
      <div style="margin-left:auto;display:flex;gap:4px">
        <button onclick="_etfSwitchView('detail')"
          style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
                 border:1px solid ${!isFocus ? 'var(--primary-2)' : 'rgba(148,163,184,.3)'};
                 background:${!isFocus ? 'rgba(99,102,241,.15)' : 'transparent'};
                 color:${!isFocus ? 'var(--primary-2)' : 'var(--text-muted)'}">📋 ETF追蹤</button>
        <button onclick="_etfSwitchView('focus')"
          style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
                 border:1px solid ${isFocus ? '#fbbf24' : 'rgba(148,163,184,.3)'};
                 background:${isFocus ? 'rgba(251,191,36,.12)' : 'transparent'};
                 color:${isFocus ? '#fbbf24' : 'var(--text-muted)'}">⭐ 重點關注</button>
      </div>
    </div>`;
  }

  // Dispatch to focus view
  if (_etfState.view === 'focus') {
    _etfRenderFocusView();
    return;
  }

  const fetchCode = _etfState.code;  // capture before async gap
  const cached = _etfState.cache[fetchCode];
  if (!force && cached) { _etfRender(cached); return; }

  body.innerHTML = '<div class="empty-state" style="padding:40px">⏳ 正在下載持股資料…</div>';
  if (subEl) subEl.textContent = '主動式ETF每日持股變化';

  try {
    const qs = `code=${encodeURIComponent(fetchCode)}${force ? '&force=true' : ''}`;
    const data = await api(`/api/etf-tracking?${qs}`);
    if (!data.error) _etfState.cache[fetchCode] = data;  // cache regardless of current tab
    if (_etfState.code !== fetchCode) return;  // tab switched mid-flight, don't render
    if (data.error) {
      body.innerHTML = `<div class="empty-state">❌ 載入失敗：${data.error}</div>`;
      return;
    }
    _etfRender(data);
  } catch (e) {
    if (_etfState.code !== fetchCode) return;
    body.innerHTML = `<div class="empty-state">❌ 請求失敗：${e.message}</div>`;
  }
}

export function _etfSwitchTab(code) {
  _etfState.code = code;
  renderEtfPage(false);
}

export function _etfSwitchView(v) {
  _etfState.view = v;
  renderEtfPage(false);
}

export function _etfRender(data) {
  const body  = document.getElementById('etf-body');
  const subEl = document.getElementById('etf-sub');
  if (!body) return;

  const {
    fundName = '—', aum, aumChange, prevAum, nav,
    date = '—', prevDate, holdings = [], summaryCounts = {}, _stale, _cached_date
  } = data;

  // ── Meta bar ──────────────────────────────────────────────────────────────
  const aumFmt  = aum ? `${(aum / 1e8).toFixed(2)} 億` : '—';
  const navFmt  = nav != null ? nav.toFixed(2) : '—';

  let aumChgHtml = '';
  if (aumChange != null) {
    const sign  = aumChange >= 0 ? '+' : '';
    const color = aumChange >= 0 ? 'var(--red)' : 'var(--green)';
    aumChgHtml = `<span style="color:${color};font-size:12px;margin-left:4px">${sign}${(aumChange / 1e8).toFixed(2)} 億</span>`;
  }

  const staleNote = _stale
    ? `<span style="color:var(--text-muted);font-size:11px"> (快取 ${_cached_date})</span>` : '';
  const compNote  = prevDate
    ? `<span style="font-size:12px;color:var(--text-muted)">　vs ${prevDate}</span>` : '';
  if (subEl) subEl.textContent = `${date}　規模：${aumFmt}`;

  const opCfg = {
    '新增建倉': { color: '#10b981', bg: 'rgba(16,185,129,.12)', icon: '🆕' },
    '股數加碼': { color: '#38bdf8', bg: 'rgba(56,189,248,.10)', icon: '➕' },
    '股數減碼': { color: '#f59e0b', bg: 'rgba(245,158,11,.10)', icon: '➖' },
    '全數清倉': { color: '#f43f5e', bg: 'rgba(244,63,94,.10)',  icon: '🔴' },
    '持有':     { color: '#64748b', bg: 'transparent',          icon: '' },
  };

  const opOrder = ['新增建倉', '股數加碼', '股數減碼', '全數清倉', '持有'];

  // Sort all holdings: operation priority first, then weight desc
  const allSorted = [...holdings].sort((a, b) => {
    const ai = opOrder.indexOf(a.operationType || '持有');
    const bi = opOrder.indexOf(b.operationType || '持有');
    if (ai !== bi) return ai - bi;
    return (b.currentWeightPercent || 0) - (a.currentWeightPercent || 0);
  });

  // Summary cards (clickable to filter)
  const ops = ['新增建倉', '股數加碼', '股數減碼', '全數清倉'];
  const cardHtml = ops.map(op => {
    const n   = summaryCounts[op] ?? 0;
    const cfg = opCfg[op];
    const active = _etfState.filterOps.has(op);
    return `<div onclick="_etfSetOpFilter('${op}')" style="cursor:pointer;
                background:var(--panel-bg);border-radius:12px;padding:14px 20px;min-width:100px;text-align:center;
                border:2px solid ${active ? cfg.color : (n > 0 ? cfg.color + '66' : 'var(--border)')};
                box-shadow:${active ? `0 0 0 3px ${cfg.color}33` : 'none'};
                transition:all .15s">
      <div style="font-size:24px;font-weight:800;color:${n > 0 ? cfg.color : 'var(--text-muted)'}">${n}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${cfg.icon} ${op}</div>
    </div>`;
  }).join('');

  const noCompNote = !prevDate
    ? `<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.35);
                  border-radius:8px;padding:8px 14px;margin-bottom:12px;font-size:12px;color:#f59e0b">
        ⚠️ 無前一日資料可比對，操作類型全部顯示為「持有」。明日起將自動顯示買賣變化。
      </div>` : '';

  // ── Market breakdown by exchange code → region ───────────────────────────
  // symbol format: "TICKER EXCH" for foreign, no space for Taiwan.
  // European exchanges (GY/FP/LN/SW/SM/SS/NA/BB/AV/DC/HE…) are all grouped
  // into one 歐洲 bucket; markets with normalised weight < 1% → 其他.
  const _EU = new Set(['GY','FP','LN','SW','SM','SS','NA','BB','AV','DC','HE','VI','LS','PL','IR']);
  const _exchToRegion = exch => _EU.has(exch) ? 'EU' : exch;
  const _mktLabel = { TW:'🇹🇼 台灣', US:'🇺🇸 美國', JP:'🇯🇵 日本', KS:'🇰🇷 韓國',
                      EU:'🌍 歐洲',   HK:'🇭🇰 香港', CH:'🇨🇳 中國', SP:'🇸🇬 新加坡',
                      AU:'🇦🇺 澳洲',  OTHER:'其他' };
  const _mktColor = { TW:'#38bdf8', US:'#818cf8', JP:'#f43f5e', KS:'#10b981',
                      EU:'#f59e0b',  HK:'#ec4899', CH:'#ef4444', SP:'#14b8a6',
                      AU:'#fb923c',  OTHER:'#64748b' };
  const mktRaw = {};
  for (const h of holdings.filter(x => (x.currentWeightPercent || 0) > 0)) {
    const sym    = h.symbol || '';
    const exch   = sym.includes(' ') ? sym.split(' ').pop() : 'TW';
    const region = _exchToRegion(exch);
    mktRaw[region] = (mktRaw[region] || 0) + (h.currentWeightPercent || 0);
  }
  const totalWt = Object.values(mktRaw).reduce((s, v) => s + v, 0);
  // Merge regions with normalised weight < 1% into 'OTHER'
  const mktMap = {};
  for (const [region, wt] of Object.entries(mktRaw)) {
    const pctNorm = totalWt > 0 ? wt / totalWt * 100 : 0;
    const key = pctNorm < 1 ? 'OTHER' : region;
    mktMap[key] = (mktMap[key] || 0) + wt;
  }
  const mktEntries = Object.entries(mktMap).sort((a, b) =>
    a[0] === 'OTHER' ? 1 : b[0] === 'OTHER' ? -1 : b[1] - a[1]);
  // Stacked horizontal bar segments
  const mktSegments = mktEntries.map(([exch, wt]) => {
    const pct  = totalWt > 0 ? (wt / totalWt * 100) : 0;
    const color = _mktColor[exch] || '#94a3b8';
    const labelPlain = (_mktLabel[exch] || exch).replace(/[\uD83C][\uDDE0-\uDDFF][\uD83C][\uDDE0-\uDDFF]\s*/g, '');
    return `<div title="${labelPlain} ${pct.toFixed(1)}%"
              style="width:${pct.toFixed(2)}%;background:${color};height:100%"></div>`;
  }).join('');
  // Legend chips: flag + name + pct, wrapping
  const mktChips = mktEntries.map(([exch, wt]) => {
    const pct   = totalWt > 0 ? (wt / totalWt * 100) : 0;
    const color = _mktColor[exch] || '#94a3b8';
    const label = _mktLabel[exch] || exch;
    return `<span style="display:inline-flex;align-items:center;gap:3px;white-space:nowrap">
      <span style="width:8px;height:8px;border-radius:2px;background:${color};flex-shrink:0;display:inline-block"></span>
      <span style="font-size:10px;color:var(--text-muted)">${label}</span>
      <span style="font-size:10px;font-weight:700;color:${color}">${pct.toFixed(1)}%</span>
    </span>`;
  }).join('');
  const mktBlockHtml = mktEntries.length ? `
    <div style="background:var(--panel-bg);border:1px solid var(--border);border-radius:8px;
                padding:8px 14px;min-width:220px;flex:1">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">市場佔比</div>
      <div style="height:10px;border-radius:5px;overflow:hidden;display:flex;margin-bottom:7px">${mktSegments}</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px 10px">${mktChips}</div>
    </div>` : '';

  body.innerHTML = `
    <!-- Fund header -->
    <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-size:15px;font-weight:700;margin-bottom:6px">${fundName}${staleNote}</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
          <div style="background:var(--panel-bg);border:1px solid var(--border);border-radius:8px;
                      padding:8px 14px;min-width:110px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">規模</div>
            <div style="font-size:14px;font-weight:700">${aumFmt}${aumChgHtml}</div>
          </div>
          <div style="background:var(--panel-bg);border:1px solid var(--border);border-radius:8px;
                      padding:8px 14px;min-width:80px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">淨值</div>
            <div style="font-size:14px;font-weight:700">${navFmt}</div>
          </div>
          <div style="background:var(--panel-bg);border:1px solid var(--border);border-radius:8px;
                      padding:8px 14px;min-width:80px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">資料日期</div>
            <div style="font-size:13px;font-weight:600">${date}${compNote}</div>
          </div>
          ${mktBlockHtml}
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${cardHtml}</div>
    </div>
    ${noCompNote}
    <div id="etf-filter-bar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;
          margin-bottom:12px;padding:8px 14px;background:var(--panel-bg);
          border:1px solid var(--border);border-radius:10px">
      <span style="font-size:11px;color:var(--text-muted);font-weight:600">篩選</span>
      <div id="etf-op-btns" style="display:flex;gap:5px;flex-wrap:wrap"></div>
      <div style="width:1px;height:18px;background:var(--border);margin:0 2px"></div>
      <span style="font-size:11px;color:var(--text-muted);font-weight:600">權重排名</span>
      <div id="etf-top-btns" style="display:flex;gap:5px"></div>
      <div style="width:1px;height:18px;background:var(--border);margin:0 2px"></div>
      <span style="font-size:11px;color:var(--text-muted);font-weight:600">排序</span>
      <div id="etf-sort-btns" style="display:flex;gap:5px;flex-wrap:wrap"></div>
      <span id="etf-filter-count" style="margin-left:auto;font-size:11px;color:var(--text-muted)"></span>
    </div>
    ${holdings.length === 0 ? '<div class="empty-state">尚無持股資料</div>' : `
    <div class="panel" style="overflow-x:auto">
      <table class="data-table" style="min-width:680px">
        <thead><tr>
          <th style="text-align:center;width:36px">#</th>
          <th>標的</th>
          <th>操作</th>
          <th style="text-align:right">權重</th>
          <th style="text-align:right">權重增減</th>
          <th style="text-align:right">持股數</th>
          <th style="text-align:right">股數增減%</th>
          <th style="text-align:right">收盤價</th>
          <th style="text-align:right">漲跌幅</th>
        </tr></thead>
        <tbody id="etf-tbody"></tbody>
      </table>
    </div>`}`;

  // Store sorted list on state so filter can re-use
  _etfState._allSorted = allSorted;
  _etfRenderFilters();
  _etfApplyFilters();
}

export function _etfRenderFilters() {
  // Op filter buttons
  const opBtns = document.getElementById('etf-op-btns');
  if (!opBtns) return;
  const opOptions = [
    { key: '新增建倉', label: '🆕 新增建倉' },
    { key: '股數加碼', label: '➕ 加碼' },
    { key: '股數減碼', label: '➖ 減碼' },
    { key: '全數清倉', label: '🔴 清倉' },
  ];
  const anyActive = _etfState.filterOps.size > 0;
  opBtns.innerHTML =
    `<button onclick="_etfClearOpFilter()"
      style="padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
             border:1px solid ${!anyActive ? 'var(--primary-2)' : 'rgba(148,163,184,.3)'};
             background:${!anyActive ? 'rgba(99,102,241,.18)' : 'transparent'};
             color:${!anyActive ? 'var(--primary-2)' : 'var(--text-muted)'}">全部</button>` +
    opOptions.map(o => {
      const active = _etfState.filterOps.has(o.key);
      return `<button onclick="_etfSetOpFilter('${o.key}')"
        style="padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
               border:1px solid ${active ? 'var(--primary-2)' : 'rgba(148,163,184,.3)'};
               background:${active ? 'rgba(99,102,241,.18)' : 'transparent'};
               color:${active ? 'var(--primary-2)' : 'var(--text-muted)'}">
        ${o.label}</button>`;
    }).join('');

  // Top-N buttons
  const topBtns = document.getElementById('etf-top-btns');
  if (!topBtns) return;
  const topOptions = [
    { key: 0,  label: '全部' },
    { key: 10, label: 'Top 10' },
    { key: 20, label: 'Top 20' },
    { key: 30, label: 'Top 30' },
  ];
  topBtns.innerHTML = topOptions.map(o => {
    const active = _etfState.filterTop === o.key;
    return `<button onclick="_etfSetTopFilter(${o.key})"
      style="padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
             border:1px solid ${active ? 'var(--primary-2)' : 'rgba(148,163,184,.3)'};
             background:${active ? 'rgba(99,102,241,.18)' : 'transparent'};
             color:${active ? 'var(--primary-2)' : 'var(--text-muted)'}">
      ${o.label}</button>`;
  }).join('');

  // Sort buttons
  const sortBtns = document.getElementById('etf-sort-btns');
  if (!sortBtns) return;
  const sortOptions = [
    { key: 'op',          label: '操作優先' },
    { key: 'weight_desc', label: '權重 ↓' },
    { key: 'weight_asc',  label: '權重 ↑' },
    { key: 'price_desc',  label: '漲跌幅 ↓' },
    { key: 'price_asc',   label: '漲跌幅 ↑' },
    { key: 'shares_desc', label: '股數增減 ↓' },
    { key: 'shares_asc',  label: '股數增減 ↑' },
  ];
  sortBtns.innerHTML = sortOptions.map(o => {
    const active = _etfState.sort === o.key;
    return `<button onclick="_etfSetSort('${o.key}')"
      style="padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
             border:1px solid ${active ? 'var(--primary-2)' : 'rgba(148,163,184,.3)'};
             background:${active ? 'rgba(99,102,241,.18)' : 'transparent'};
             color:${active ? 'var(--primary-2)' : 'var(--text-muted)'}">
      ${o.label}</button>`;
  }).join('');
}

export function _etfClearOpFilter() {
  _etfState.filterOps.clear();
  _etfRenderFilters();
  _etfApplyFilters();
}

export function _etfSetOpFilter(op) {
  if (_etfState.filterOps.has(op)) _etfState.filterOps.delete(op);
  else _etfState.filterOps.add(op);
  _etfRenderFilters();
  _etfApplyFilters();
}

export function _etfSetTopFilter(n) {
  _etfState.filterTop = _etfState.filterTop === n ? 0 : n;
  _etfRenderFilters();
  _etfApplyFilters();
}

export function _etfSetSort(key) {
  _etfState.sort = key;
  _etfRenderFilters();
  _etfApplyFilters();
}

export function _etfRenderCards(data) {
  // Re-render just the summary cards without rebuilding the whole page
  const { summaryCounts = {} } = data;
  const opCfg = {
    '新增建倉': { color: '#10b981', icon: '🆕' },
    '股數加碼': { color: '#38bdf8', icon: '➕' },
    '股數減碼': { color: '#f59e0b', icon: '➖' },
    '全數清倉': { color: '#f43f5e', icon: '🔴' },
  };
  // cards are inside body — can't re-render individually easily, skip
}

export function _etfApplyFilters() {
  const tbody = document.getElementById('etf-tbody');
  const countEl = document.getElementById('etf-filter-count');
  if (!tbody || !_etfState._allSorted) return;

  const opCfg = {
    '新增建倉': { color: '#10b981', bg: 'rgba(16,185,129,.12)', icon: '🆕' },
    '股數加碼': { color: '#38bdf8', bg: 'rgba(56,189,248,.10)', icon: '➕' },
    '股數減碼': { color: '#f59e0b', bg: 'rgba(245,158,11,.10)', icon: '➖' },
    '全數清倉': { color: '#f43f5e', bg: 'rgba(244,63,94,.10)',  icon: '🔴' },
    '持有':     { color: '#64748b', bg: 'transparent',          icon: '' },
  };

  const fmtPct = (v) => {
    if (v == null || v === 0) return '<span class="muted">—</span>';
    const sign  = v > 0 ? '+' : '';
    const color = v > 0 ? 'var(--red)' : 'var(--green)';
    return `<span style="color:${color}">${sign}${Number(v).toFixed(2)}%</span>`;
  };
  const _NO_DECIMAL_CURRENCIES = new Set(['KRW', 'JPY', 'IDR', 'VND']);
  const fmtPrice = (v, currency = 'TWD') => {
    if (v == null) return '—';
    const n = Number(v);
    if (_NO_DECIMAL_CURRENCIES.has(currency)) return n.toLocaleString('en', { maximumFractionDigits: 0 });
    return n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Top-N filter operates on weight rank (position in allSorted, within 持有+all)
  // Rank is based on currentWeightPercent among current holdings (全數清倉 = 0 weight)
  const ranked = [..._etfState._allSorted]
    .filter(h => (h.currentWeightPercent ?? 0) > 0)
    .sort((a, b) => (b.currentWeightPercent || 0) - (a.currentWeightPercent || 0));
  const topSyms = new Set(
    _etfState.filterTop > 0 ? ranked.slice(0, _etfState.filterTop).map(h => h.symbol) : []
  );

  let visible = [..._etfState._allSorted];

  // Apply op filter (multi-select, empty = all)
  if (_etfState.filterOps.size > 0) {
    visible = visible.filter(h => _etfState.filterOps.has(h.operationType || '持有'));
  }

  // Apply top-N filter (intersect)
  if (_etfState.filterTop > 0) {
    visible = visible.filter(h => topSyms.has(h.symbol));
  }

  // Apply sort
  const opOrder = ['新增建倉', '股數加碼', '股數減碼', '全數清倉', '持有'];
  switch (_etfState.sort) {
    case 'weight_desc':
      visible.sort((a, b) => (b.currentWeightPercent || 0) - (a.currentWeightPercent || 0));
      break;
    case 'weight_asc':
      visible.sort((a, b) => (a.currentWeightPercent || 0) - (b.currentWeightPercent || 0));
      break;
    case 'price_desc':
      visible.sort((a, b) => (b.priceChangePercent || 0) - (a.priceChangePercent || 0));
      break;
    case 'price_asc':
      visible.sort((a, b) => (a.priceChangePercent || 0) - (b.priceChangePercent || 0));
      break;
    case 'shares_desc':
      visible.sort((a, b) => (b.sharesChangePercent || 0) - (a.sharesChangePercent || 0));
      break;
    case 'shares_asc':
      visible.sort((a, b) => (a.sharesChangePercent || 0) - (b.sharesChangePercent || 0));
      break;
    default: // 'op': operation priority → weight desc (already the order of _allSorted)
      break;
  }

  // Rank label: weight rank among all current holdings
  const rankMap = new Map(ranked.map((h, i) => [h.symbol, i + 1]));

  if (countEl) {
    const total = _etfState._allSorted.length;
    countEl.textContent = visible.length < total
      ? `顯示 ${visible.length} / ${total} 檔`
      : `共 ${total} 檔`;
  }

  tbody.innerHTML = visible.map(h => {
    const op  = h.operationType || '持有';
    const cfg = opCfg[op] || opCfg['持有'];
    const badge = op !== '持有'
      ? `<span style="background:${cfg.bg};color:${cfg.color};font-size:11px;font-weight:700;
                      padding:2px 8px;border-radius:4px;border:1px solid ${cfg.color}">${op}</span>`
      : `<span style="color:var(--text-muted);font-size:12px">持有</span>`;

    const rank = rankMap.get(h.symbol);
    const rankCell = rank
      ? `<span style="color:var(--text-muted);font-size:12px">${rank}</span>`
      : `<span style="color:var(--text-muted);font-size:12px">—</span>`;

    const sharesStr = h.shares != null ? Number(h.shares).toLocaleString() : '—';
    const prevSharesNote = (h.prevShares != null && h.prevShares !== h.shares && h.prevShares > 0)
      ? `<div style="font-size:10px;color:var(--text-muted);margin-top:1px">前 ${Number(h.prevShares).toLocaleString()}</div>`
      : '';

    const wPct = h.currentWeightPercent;

    return `<tr style="${op !== '持有' ? `background:${cfg.bg}` : ''}">
      <td style="text-align:center;color:var(--text-muted);font-size:12px">${rankCell}</td>
      <td style="line-height:1.3;padding:8px 10px">
        <div class="mono" style="font-weight:700;font-size:13px;color:var(--text)">${h.symbol || '—'}</div>
        <div style="font-size:11px;color:var(--text-muted)">${h.name || ''}</div>
      </td>
      <td style="white-space:nowrap">${badge}</td>
      <td class="mono" style="text-align:right">
        ${wPct != null ? `<div style="font-weight:600">${wPct.toFixed(2)}%</div>` : '—'}
      </td>
      <td class="mono" style="text-align:right">${fmtPct(h.weightChangePercent)}</td>
      <td class="mono" style="text-align:right;font-size:12px">
        <div>${sharesStr}</div>${prevSharesNote}
      </td>
      <td class="mono" style="text-align:right">${fmtPct(h.sharesChangePercent)}</td>
      <td class="mono" style="text-align:right;font-weight:600">
        ${h.closingPrice != null
          ? `${fmtPrice(h.closingPrice, h.currency)}${h.currency && h.currency !== 'TWD' ? `<div style="font-size:10px;color:var(--text-muted)">${h.currency}</div>` : ''}`
          : '—'}
      </td>
      <td class="mono" style="text-align:right">${_fmtPctLimit(h.priceChangePercent)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--text-muted)">無符合條件的持股</td></tr>`;
}

// ── ETF 重點關注 ────────────────────────────────────────────────────────────
export async function _etfRenderFocusView() {
  const body  = document.getElementById('etf-body');
  const subEl = document.getElementById('etf-sub');
  if (!body) return;

  if (subEl) subEl.textContent = _etfFocusCodes.join(' · ') + ' 重點標的彙整';
  body.innerHTML = '<div class="empty-state" style="padding:40px">⏳ 彙整各ETF重點標的…</div>';

  const opCfg = {
    '新增建倉': { color: '#10b981', bg: 'rgba(16,185,129,.12)', icon: '🆕', short: '新增建倉' },
    '股數加碼': { color: '#38bdf8', bg: 'rgba(56,189,248,.10)', icon: '➕', short: '加碼' },
    '股數減碼': { color: '#f59e0b', bg: 'rgba(245,158,11,.10)', icon: '➖', short: '減碼' },
    '全數清倉': { color: '#f43f5e', bg: 'rgba(244,63,94,.10)',  icon: '🔴', short: '清倉' },
  };
  const etfColor = { '00981A': '#6366f1', '00988A': '#ec4899', '00403A': '#14b8a6', '00991A': '#10b981', '00992A': '#f59e0b' };

  // Parallel fetch; use cache when available
  const settled = await Promise.allSettled(_etfFocusCodes.map(async code => {
    if (_etfState.cache[code]) return { code, data: _etfState.cache[code] };
    const data = await api(`/api/etf-tracking?code=${code}`);
    if (!data.error) _etfState.cache[code] = data;
    return { code, data };
  }));

  if (_etfState.view !== 'focus') return;  // switched away mid-fetch

  // symbol → { name, price, changePct, etfEntries: [{etf, reasons, weight, op}] }
  const stockMap = new Map();

  for (const res of settled) {
    if (res.status !== 'fulfilled') continue;
    const { code, data } = res.value;
    if (!data || data.error || !Array.isArray(data.holdings)) continue;

    const ranked = [...data.holdings]
      .filter(h => (h.currentWeightPercent ?? 0) > 0)
      .sort((a, b) => (b.currentWeightPercent || 0) - (a.currentWeightPercent || 0));
    const top10 = new Set(ranked.slice(0, 10).map(h => h.symbol));
    const rankOf = new Map(ranked.map((h, i) => [h.symbol, i + 1]));

    for (const h of data.holdings) {
      const reasons = [];
      if (h.operationType && h.operationType !== '持有')
        reasons.push({ type: 'op', op: h.operationType });
      if (top10.has(h.symbol))
        reasons.push({ type: 'top10', rank: rankOf.get(h.symbol) });
      if (reasons.length === 0) continue;

      if (!stockMap.has(h.symbol))
        stockMap.set(h.symbol, { name: h.name, price: null, changePct: null, etfEntries: [] });
      const s = stockMap.get(h.symbol);
      if (h.closingPrice != null) { s.price = h.closingPrice; s.changePct = h.priceChangePercent; }
      s.etfEntries.push({ etf: code, reasons, weight: h.currentWeightPercent ?? 0, op: h.operationType });
    }
  }

  if (stockMap.size === 0) {
    body.innerHTML = `<div class="empty-state">⚠️ 尚無資料，請先切換到「ETF追蹤」頁面載入各檔ETF</div>`;
    return;
  }

  const opPri = { '新增建倉': 0, '股數加碼': 1, '股數減碼': 2, '全數清倉': 3 };
  const entries = [...stockMap.entries()].sort((a, b) => {
    const [, av] = a, [, bv] = b;
    // Multi-ETF first
    if (bv.etfEntries.length !== av.etfEntries.length) return bv.etfEntries.length - av.etfEntries.length;
    // Best op priority
    const bestOp = v => Math.min(...v.etfEntries.map(e => opPri[e.op] ?? 99));
    const opDiff = bestOp(av) - bestOp(bv);
    if (opDiff !== 0) return opDiff;
    // Max weight
    return Math.max(...bv.etfEntries.map(e => e.weight)) - Math.max(...av.etfEntries.map(e => e.weight));
  });

  const fmtPct = _fmtPctLimit;

  // Categorise into 3 buckets
  const isSell = s => s.etfEntries.some(e => e.op === '股數減碼' || e.op === '全數清倉');
  const tMulti = entries.filter(([, s]) => s.etfEntries.length > 1);
  const tSell  = entries.filter(([, s]) => s.etfEntries.length === 1 && isSell(s));
  const tOther = entries.filter(([, s]) => s.etfEntries.length === 1 && !isSell(s));

  // Compact row for a single stock
  const mkRow = ([sym, s]) => {
    const multi = s.etfEntries.length > 1;
    const tags = s.etfEntries.map(e => {
      const ec = etfColor[e.etf] || '#94a3b8';
      const chips = e.reasons.map(r => {
        if (r.type === 'op') {
          const c = opCfg[r.op];
          return `<span style="background:${c.bg};color:${c.color};font-size:11px;font-weight:700;
                              padding:1px 5px;border-radius:3px;border:1px solid ${c.color}">${c.icon}${c.short}</span>`;
        }
        return `<span style="background:rgba(99,102,241,.15);color:#818cf8;font-size:11px;font-weight:700;
                            padding:1px 5px;border-radius:3px;border:1px solid rgba(99,102,241,.3)">TOP${r.rank}</span>`;
      }).join(' ');
      return `<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;flex-wrap:wrap">
        <span style="background:${ec}22;color:${ec};font-size:11px;font-weight:700;
                    padding:1px 5px;border-radius:3px;min-width:52px;text-align:center">${e.etf}</span>
        ${chips}
      </div>`;
    }).join('');
    const multiBadge = multi
      ? ` <span style="background:rgba(251,191,36,.18);color:#fbbf24;font-size:11px;font-weight:800;
                      padding:1px 5px;border-radius:3px;border:1px solid rgba(251,191,36,.5)">★${s.etfEntries.length}</span>`
      : '';
    const pc = (s.changePct ?? 0) > 0 ? 'var(--red)' : (s.changePct ?? 0) < 0 ? 'var(--green)' : 'var(--text)';
    return `<tr>
      <td style="padding:7px 10px;white-space:nowrap">
        <div style="display:flex;align-items:center;gap:4px">
          <span class="mono" style="font-weight:700;font-size:14px">${sym}</span>${multiBadge}
        </div>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.3;margin-top:1px">${s.name || ''}</div>
      </td>
      <td style="padding:7px 10px;white-space:nowrap">${tags}</td>
      <td class="mono" style="text-align:right;padding:7px 10px;font-size:13px;font-weight:600;color:${pc};white-space:nowrap">
        ${s.price != null ? Number(s.price).toFixed(2) : '—'}
      </td>
      <td class="mono" style="text-align:right;padding:7px 10px;font-size:12px;white-space:nowrap">
        ${fmtPct(s.changePct)}
      </td>
    </tr>`;
  };

  const mkTable = (list, accent) => {
    if (list.length === 0) return '<div style="padding:16px;text-align:center;font-size:12px;color:var(--text-muted)">—</div>';
    return `<table class="data-table" style="width:auto;min-width:100%">
      <thead style="background:${accent}12"><tr>
        <th style="font-size:12px;font-weight:700;padding:6px 10px;border-bottom:2px solid ${accent}44;white-space:nowrap">標的</th>
        <th style="font-size:12px;font-weight:700;padding:6px 10px;border-bottom:2px solid ${accent}44;white-space:nowrap">關注原因</th>
        <th style="font-size:12px;font-weight:700;padding:6px 10px;text-align:right;border-bottom:2px solid ${accent}44;white-space:nowrap">收盤價</th>
        <th style="font-size:12px;font-weight:700;padding:6px 10px;text-align:right;border-bottom:2px solid ${accent}44;white-space:nowrap">漲跌幅</th>
      </tr></thead>
      <tbody>${list.map(mkRow).join('')}</tbody>
    </table>`;
  };

  const mkSection = (icon, title, list, accent) =>
    `<div style="border-radius:10px;overflow:hidden;border:1px solid ${accent}44;background:var(--panel-bg);display:flex;flex-direction:column">
      <div style="padding:8px 14px;background:${accent}1c;border-bottom:1px solid ${accent}33;
                  display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span style="font-size:16px">${icon}</span>
        <span style="font-weight:800;font-size:15px;color:${accent};letter-spacing:.3px">${title}</span>
        <span style="font-size:12px;font-weight:600;color:${accent}99;margin-left:auto">${list.length} 檔</span>
      </div>
      <div style="overflow-y:auto;flex:1">${mkTable(list, accent)}</div>
    </div>`;

  // Date/time header
  const fetchedAt = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const etfDateTags = settled
    .filter(r => r.status === 'fulfilled' && r.value?.data && !r.value.data.error)
    .map(r => {
      const { code, data } = r.value;
      const d = data.date || data._cached_date || '—';
      const ec = etfColor[code] || '#94a3b8';
      const staleTag = data._stale
        ? ` <span style="background:rgba(245,158,11,.2);color:#f59e0b;font-size:10px;font-weight:700;
                         padding:0 4px;border-radius:3px">舊</span>`
        : '';
      return `<span style="background:${ec}18;color:${ec};font-size:11px;font-weight:700;
                           padding:2px 8px;border-radius:4px;border:1px solid ${ec}44">
                ${code} <span style="font-weight:400">${d}</span>${staleTag}
              </span>`;
    }).join('');

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--text-muted);font-weight:600">資料日期</span>
      ${etfDateTags}
      <span style="font-size:11px;color:var(--text-muted);margin-left:auto">取得時間 ${fetchedAt}</span>
    </div>
    <div class="etf-focus-grid">
      ${mkSection('★', '多檔共同入選', tMulti, '#fbbf24')}
      ${mkSection('📈', '新增建倉 / 加碼', tOther, '#38bdf8')}
      ${mkSection('⚠️', '減碼 / 清倉', tSell, '#f43f5e')}
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px">共 ${entries.length} 個重點標的</div>`;
}
