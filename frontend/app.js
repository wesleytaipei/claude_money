/* ══════════════════════════════════════════════════════════════════════════
   HC Finance — Frontend Logic
   ══════════════════════════════════════════════════════════════════════════ */
const API = '';  // same origin

// ── State ────────────────────────────────────────────────────────────────
const state = {
  portfolio: { assets: [], liabilities: [], investments: [] },
  prices: {},        // ticker -> {price, currency}
  indices: {},       // market indices
  manualHistory: [],
  history: {},       // daily snapshots from alm_history
  privacy: false,
  currentInv: 'stock',  // stock | cb | us
  pnlYear: new Date().getFullYear(),
  usdTwd: 31.77,
  jpyTwd: 0.2,
  excluded: new Set(),  // keys like "assets.0.1" or "assets.0.*"
};

// Load excluded from localStorage
try {
  const saved = localStorage.getItem('hc_excluded');
  if (saved) state.excluded = new Set(JSON.parse(saved));
} catch (e) {}

function saveExcluded() {
  localStorage.setItem('hc_excluded', JSON.stringify([...state.excluded]));
}
function itemKey(section, gi, ii) { return `${section}.${gi}.${ii}`; }
function groupKey(section, gi) { return `${section}.${gi}.*`; }
function isExcluded(section, gi, ii) {
  return state.excluded.has(groupKey(section, gi)) || state.excluded.has(itemKey(section, gi, ii));
}

const charts = {};

// ── Constants ────────────────────────────────────────────────────────────
const CHART_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4',
  '#a855f7', '#f43f5e', '#84cc16', '#3b82f6', '#f97316',
];

// Chart.js plugin: draw percentage labels on doughnut slices
const doughnutLabelPlugin = {
  id: 'doughnutLabels',
  afterDraw(chart) {
    if (chart.config.type !== 'doughnut') return;
    const { ctx } = chart;
    const dataset = chart.data.datasets[0];
    const total = dataset.data.reduce((s, v) => s + v, 0);
    if (!total) return;

    const meta = chart.getDatasetMeta(0);
    ctx.save();
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    meta.data.forEach((arc, i) => {
      const pct = dataset.data[i] / total * 100;
      if (pct < 3) return; // skip tiny slices
      const { x, y } = arc.tooltipPosition();
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 3;
      ctx.fillText(pct.toFixed(1) + '%', x, y);
      ctx.shadowBlur = 0;
    });
    ctx.restore();
  }
};
Chart.register(doughnutLabelPlugin);

const INV_GROUP_MAP = {
  stock: '股票',
  cb:    '可轉債',
  us:    '美國股市',
};

// ══ API wrapper ═════════════════════════════════════════════════════════
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ══ Expression evaluator ═════════════════════════════════════════════════
function evalExpr(str) {
  const s = String(str).trim();
  if (!s) return '';
  // Only allow: digits, operators +−*/%, dot, parentheses, spaces
  if (!/^[\d\s+\-*/.()%]+$/.test(s)) return s;
  // Skip if it's already a plain number
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + s + ')')();
    if (typeof result === 'number' && isFinite(result)) {
      return (+result.toFixed(10)).toString();
    }
  } catch (e) { /* leave as-is */ }
  return s;
}

// Global blur handler — evaluate arithmetic in any decimal input
document.addEventListener('blur', (e) => {
  const el = e.target;
  if (el.tagName !== 'INPUT') return;
  if (el.getAttribute('inputmode') !== 'decimal') return;
  const evaluated = evalExpr(el.value);
  if (evaluated !== el.value) {
    el.value = evaluated;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, true);

// ══ Utils ═══════════════════════════════════════════════════════════════
function fmt(n, currency = 'TWD') {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (currency === 'USD') return 'US$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === 'JPY') return '¥' + Math.round(n).toLocaleString();
  if (Math.abs(n) >= 1e8) return 'NT$' + (n / 1e8).toFixed(2) + '億';
  if (Math.abs(n) >= 1e4) return 'NT$' + (n / 1e4).toFixed(1) + '萬';
  return 'NT$' + Math.round(n).toLocaleString();
}

function fmtFull(n) {
  if (n == null || isNaN(n)) return '—';
  return 'NT$ ' + Math.round(n).toLocaleString();
}

function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + Number(n).toFixed(digits) + '%';
}

function toTWD(amount, currency) {
  if (!currency || currency === 'TWD') return amount;
  if (currency === 'USD') return amount * state.usdTwd;
  if (currency === 'JPY') return amount * state.jpyTwd;
  return amount;
}

// Format price with 2 decimal places
function fmtPrice(n) {
  if (n == null || isNaN(n) || Number(n) === 0) return '—';
  return Number(n).toFixed(2);
}

function pnlClass(v) {
  if (v > 0) return 'profit';
  if (v < 0) return 'loss';
  return 'muted';
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr.replace(/\//g, '-'));
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

function dateWarnClass(dateStr) {
  const d = daysUntil(dateStr);
  if (d == null) return '';
  if (d < 90) return 'cell-warn-red';
  if (d < 180) return 'cell-warn-orange';
  return '';
}

function percentWarnClass(pct, redThr, orangeThr) {
  if (pct == null) return '';
  if (pct < redThr) return 'cell-warn-red';
  if (pct < orangeThr) return 'cell-warn-orange';
  return '';
}

function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2400);
}

// ══ Calculations ════════════════════════════════════════════════════════
function calcTotals() {
  const p = state.portfolio;
  let totalAssets = 0;
  let totalInvestment = 0;
  let totalInvCost = 0;
  const groupTotals = {};

  // Assets
  for (let gi = 0; gi < p.assets.length; gi++) {
    const g = p.assets[gi];
    let groupSum = 0;
    for (let ii = 0; ii < g.items.length; ii++) {
      const item = g.items[ii];
      const v = toTWD(Number(item.amount) || 0, item.currency);
      item._twd = v;
      if (!isExcluded('assets', gi, ii)) groupSum += v;
    }
    groupTotals[g.group] = groupSum;
    totalAssets += groupSum;
  }

  // Investments
  for (let gi = 0; gi < p.investments.length; gi++) {
    const g = p.investments[gi];
    let groupSum = 0;
    let groupCost = 0;
    for (let ii = 0; ii < g.items.length; ii++) {
      const item = g.items[ii];
      const isCB = g.group === '可轉債';
      const isUS = g.group === '美國股市';
      const price = Number(item.current_price) || 0;
      const cost = Number(item.cost) || 0;
      const shares = Number(item.shares) || 0;
      const entry = Number(item.entry_price) || 0;

      let mv;
      if (isCB) {
        mv = cost + (price - entry) * shares;
      } else {
        mv = shares * price;
      }
      const mvTWD = isUS ? mv * state.usdTwd : mv;
      const costTWD = isUS ? cost * state.usdTwd : cost;

      item._mv = mv;
      item._mv_twd = mvTWD;
      item._cost_twd = costTWD;
      item._pnl = (price - entry) * shares;
      item._pnl_twd = isUS ? item._pnl * state.usdTwd : item._pnl;
      item._pnl_pct = cost > 0 ? ((price - entry) * shares / cost * 100) : 0;

      if (!isExcluded('investments', gi, ii)) {
        groupSum += mvTWD;
        groupCost += costTWD;
      }
    }
    groupTotals[g.group] = groupSum;
    totalAssets += groupSum;
    totalInvestment += groupSum;
    totalInvCost += groupCost;
  }

  // Liabilities
  let totalDebts = 0;
  for (let gi = 0; gi < p.liabilities.length; gi++) {
    const g = p.liabilities[gi];
    let groupSum = 0;
    for (let ii = 0; ii < g.items.length; ii++) {
      const item = g.items[ii];
      const v = toTWD(Number(item.amount) || 0, item.currency);
      item._twd = v;
      if (!isExcluded('liabilities', gi, ii)) groupSum += v;
    }
    totalDebts += groupSum;
  }

  const netWorth = totalAssets - totalDebts;
  const leverage = netWorth > 0 ? totalAssets / netWorth : 0;
  const exposure = netWorth > 0 ? (totalInvestment / netWorth * 100) : 0;
  const invPnL = totalInvestment - totalInvCost;
  const invPnLPct = totalInvCost > 0 ? (invPnL / totalInvCost * 100) : 0;

  return { totalAssets, totalDebts, netWorth, leverage, exposure,
           totalInvestment, totalInvCost, invPnL, invPnLPct, groupTotals };
}

// ══ Data loading ════════════════════════════════════════════════════════
async function loadPortfolio() {
  try {
    state.portfolio = await api('/api/portfolio');
  } catch (e) { console.error(e); }
}

async function loadIndices() {
  try {
    state.indices = await api('/api/indices');
    if (state.indices.usd_twd) state.usdTwd = state.indices.usd_twd;
    if (state.indices.jpy_twd) state.jpyTwd = state.indices.jpy_twd;
  } catch (e) { console.error(e); }
}

async function loadManualHistory() {
  try {
    state.manualHistory = await api('/api/manual-history');
  } catch (e) { console.error(e); }
}

async function loadHistory() {
  try {
    state.history = await api('/api/history');
    updateLastSaveDisplay();
  } catch (e) { console.error(e); }
}

function updateLastSaveDisplay() {
  const el = document.getElementById('last-save');
  if (!el) return;
  // Prefer precise localStorage timestamp (set on each save)
  const ts = localStorage.getItem('hc_last_save_time');
  if (ts) {
    const d = new Date(ts);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    el.innerHTML = `上次儲存<br>${yy}/${mm}/${dd} ${hh}:${mi}`;
    return;
  }
  // Fallback: use latest history snapshot date (date-only)
  const dates = Object.keys(state.history || {}).sort();
  if (!dates.length) { el.textContent = ''; return; }
  const last = dates[dates.length - 1];  // "2026-04-13"
  const [y, m, d] = last.split('-');
  el.innerHTML = `上次儲存<br>${y}/${m}/${d}`;
}

async function refreshCbSuspensions() {
  try {
    const data = await api('/api/cb-suspension/status');
    const suspended = data.suspended || {};
    const cbGroup = state.portfolio.investments.find(g => g.group === '可轉債');
    if (cbGroup) {
      for (const item of cbGroup.items) {
        const dateRange = suspended[item.symbol];
        item._suspended        = dateRange !== undefined;
        item._suspension_dates = dateRange || null;
      }
    }
    state._cbSuspensionLoaded = true;
  } catch (e) { console.warn('cb-suspension fetch failed:', e); }
}

async function refreshPrices() {
  const twStocks  = [];   // TW stock symbols (no suffix)
  const usTickers = [];   // US stock symbols
  const cbSymbols = [];   // CB symbols

  for (const g of state.portfolio.investments) {
    const isUS    = g.group === '美國股市';
    const isCB    = g.group === '可轉債';
    const isStock = g.group === '股票';
    for (const item of g.items) {
      if (!item.symbol) continue;
      if (isUS)    usTickers.push(item.symbol);
      else if (isCB)    cbSymbols.push(item.symbol);
      else if (isStock) twStocks.push(item.symbol);
    }
  }

  const promises = [];

  // TW stocks → MIS API (handles both TSE 上市 and OTC 上櫃, returns change_pct)
  if (twStocks.length > 0) {
    const q = [...new Set(twStocks)].join(',');
    promises.push(
      api('/api/tw-prices?symbols=' + encodeURIComponent(q))
        .then(data => {
          for (const g of state.portfolio.investments) {
            if (g.group !== '股票') continue;
            for (const item of g.items) {
              if (!item.symbol) continue;
              const d = data[item.symbol];
              if (d && d.price != null) item.current_price = d.price;
              if (d && d.change_pct != null) item._change_pct = d.change_pct;
            }
          }
        })
        .catch(e => console.error('tw-prices error:', e))
    );
  }

  // US stocks → yfinance (change_pct from previous_close)
  if (usTickers.length > 0) {
    const q = [...new Set(usTickers)].join(',');
    promises.push(
      api('/api/prices?tickers=' + encodeURIComponent(q))
        .then(data => {
          Object.assign(state.prices, data);
          for (const g of state.portfolio.investments) {
            if (g.group !== '美國股市') continue;
            for (const item of g.items) {
              if (!item.symbol) continue;
              const d = data[item.symbol];
              if (d && d.price != null) item.current_price = d.price;
              if (d && d.change_pct != null) item._change_pct = d.change_pct;
            }
          }
        })
        .catch(e => console.error('us-prices error:', e))
    );
  }

  // Fetch CB data via CBAS API (full fields including price)
  if (cbSymbols.length > 0) {
    const q = [...new Set(cbSymbols)].join(',');
    promises.push(
      api('/api/cb-prices?symbols=' + encodeURIComponent(q))
        .then(data => {
          for (const g of state.portfolio.investments) {
            if (g.group !== '可轉債') continue;
            for (const item of g.items) {
              if (!item.symbol) continue;
              const d = data[item.symbol];
              if (!d) continue;
              if (d.price)                    item.current_price     = d.price;
              if (d.change_pct != null)       item._change_pct       = d.change_pct;
              if (d.stock_change_pct != null) item._stock_change_pct = d.stock_change_pct;
              if (d.suspended != null)         item._suspended         = d.suspended;
              if (d.suspension_dates !== undefined) item._suspension_dates = d.suspension_dates;
              if (d.name && !item.name)       item.name              = d.name;
              if (d.cb_due_date)      item.cb_due_date    = d.cb_due_date;
              if (d.issued_shares)    item.issued_shares  = d.issued_shares;
              if (d.remain_shares != null) item.remain_shares = d.remain_shares;
              if (d.conversion_price) item.conversion_price = d.conversion_price;
              if (d.premium_rate != null)  item.premium_rate = d.premium_rate;
              if (d.stock_price)      item.stock_price    = d.stock_price;
            }
          }
        })
        .catch(e => console.error('cb-prices error:', e))
    );
  }

  await Promise.all(promises);
}

// ══ Render: Dashboard ═══════════════════════════════════════════════════
function renderDashboard() {
  const t = calcTotals();

  document.getElementById('kpi-net-worth').textContent = fmtFull(t.netWorth);
  document.getElementById('kpi-net-worth-usd').textContent = 'US$ ' + (t.netWorth / state.usdTwd).toLocaleString('en', { maximumFractionDigits: 0 });

  document.getElementById('kpi-total-assets').textContent = fmtFull(t.totalAssets);
  document.getElementById('kpi-total-assets-usd').textContent = 'US$ ' + (t.totalAssets / state.usdTwd).toLocaleString('en', { maximumFractionDigits: 0 });

  document.getElementById('kpi-total-debts').textContent = fmtFull(t.totalDebts);
  const debtRatio = t.totalAssets > 0 ? (t.totalDebts / t.totalAssets * 100) : 0;
  document.getElementById('kpi-debt-ratio').textContent = '負債率 ' + debtRatio.toFixed(1) + '%';

  const levEl = document.getElementById('kpi-leverage');
  levEl.textContent = t.leverage.toFixed(2) + 'x';
  levEl.style.color = t.leverage > 2 ? 'var(--red-2)' : '';

  const expEl = document.getElementById('kpi-exposure');
  expEl.textContent = t.exposure.toFixed(1) + '%';
  expEl.style.color = t.exposure > 100 ? 'var(--amber)' : '';

  // Allocation
  const entries = Object.entries(t.groupTotals)
    .filter(([_, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [_, v]) => s + v, 0);

  document.getElementById('alloc-total').textContent = fmtFull(total);

  // Donut chart
  const ctx = document.getElementById('alloc-chart').getContext('2d');
  const labels = entries.map(e => e[0]);
  const data = entries.map(e => e[1]);
  const colors = entries.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);

  if (charts.alloc) {
    charts.alloc.data.labels = labels;
    charts.alloc.data.datasets[0].data = data;
    charts.alloc.data.datasets[0].backgroundColor = colors;
    charts.alloc.update();
  } else {
    charts.alloc = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: '#0d1530', borderWidth: 3, hoverOffset: 8 }] },
      options: {
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a2547',
            borderColor: '#334b82',
            borderWidth: 1,
            titleColor: '#e8ecf6',
            bodyColor: '#a7b0c8',
            padding: 12,
            callbacks: {
              label: (c) => {
                const pct = total > 0 ? (c.raw / total * 100).toFixed(1) : 0;
                return ` ${c.label}: ${fmtFull(c.raw)} (${pct}%)`;
              }
            }
          }
        }
      }
    });
  }

  // Legend
  document.getElementById('alloc-legend').innerHTML = entries.map(([label, val], i) => {
    const pct = total > 0 ? (val / total * 100).toFixed(1) : 0;
    return `<div class="legend-item">
      <span class="legend-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
      <span class="legend-label">${label}</span>
      <span class="legend-value">${fmt(val)}</span>
      <span class="legend-pct">${pct}%</span>
    </div>`;
  }).join('');

  // Indices
  renderIndices();

  renderPnLGrid();  // async, uses history — fire and forget

  document.getElementById('dash-time').textContent = '更新於 ' + new Date().toLocaleString('zh-TW');
}

// ══ PnL Grid (year-based) ════════════════════════════════════════════════
const _INV_HIST_GROUPS = ['股票', '可轉債', '美國股市'];

function _invMVFromSnap(snap) {
  if (!snap?.asset_groups) return 0;
  return _INV_HIST_GROUPS.reduce((s, g) => s + (snap.asset_groups[g] || 0), 0);
}

async function renderPnLGrid(year) {
  if (year != null) state.pnlYear = year;
  const curYear = new Date().getFullYear();
  year = state.pnlYear;

  if (Object.keys(state.history).length === 0) await loadHistory();

  const allHistYears = [...new Set(Object.keys(state.history).map(d => +d.slice(0, 4)))].sort();
  if (!allHistYears.includes(curYear)) allHistYears.push(curYear);

  const switcher = allHistYears.map(y =>
    `<button class="year-btn${y === year ? ' active' : ''}" onclick="renderPnLGrid(${y})">${y}</button>`
  ).join('');

  const container = document.getElementById('pnl-grid');

  const fmtPnL = (v) => {
    const cls = v >= 0 ? 'profit' : 'loss';
    const s   = v >= 0 ? '+' : '';
    return `<div class="pnl-card-value ${cls}">${s}${fmtFull(Math.abs(v))}</div>
            <div class="pnl-card-sub ${cls}">${v >= 0 ? '+' : ''}${fmtPct(Math.abs(v) > 0 && v !== 0 ? null : 0)}</div>`;
  };

  if (year === curYear) {
    // ── Current year: 5 cards ─────────────────────────────────────────
    let allInvMV = 0, allInvCost = 0;
    for (const g of state.portfolio.investments) {
      for (const item of g.items) {
        allInvMV   += item._mv_twd   || 0;
        allInvCost += item._cost_twd || 0;
      }
    }
    const unrealized    = allInvMV - allInvCost;
    const unrealizedPct = allInvCost > 0 ? unrealized / allInvCost * 100 : 0;

    // Find current year's first snapshot → starting net worth
    const curYearSnaps = Object.keys(state.history)
      .filter(d => d.startsWith(year + '-')).sort();
    const startKey  = curYearSnaps[0];
    const startNW   = startKey ? (state.history[startKey].net_worth || 0) : 0;

    // 累計損益 = 目前淨資產 - 起始淨資產
    const curNW   = calcTotals().netWorth;
    const total   = startNW > 0 ? curNW - startNW : null;

    // 已實現損益 = 累計損益 - 未實現損益
    const realized    = total != null ? total - unrealized : null;
    const totalPct    = startNW > 0 ? (total ?? 0) / startNW * 100 : 0;
    const totalItems  = state.portfolio.investments.reduce((s, g) => s + g.items.length, 0);
    const breakdown   = state.portfolio.investments.map(g => `${g.group} ${g.items.length}檔`).join(' · ');

    const pnlCard = (label, v, sub, subCls = '') => `
      <div class="pnl-card">
        <div class="pnl-card-label">${label}</div>
        <div class="pnl-card-value ${v >= 0 ? 'profit' : 'loss'}">${v >= 0 ? '+' : ''}${fmtFull(Math.abs(v))}</div>
        <div class="pnl-card-sub ${subCls}">${sub}</div>
      </div>`;

    const realizedCard = realized != null
      ? `<div class="pnl-card">
           <div class="pnl-card-label">已實現損益</div>
           <div class="pnl-card-value ${realized >= 0 ? 'profit' : 'loss'}">${realized >= 0 ? '+' : ''}${fmtFull(Math.abs(realized))}</div>
           <div class="pnl-card-sub priv-amt">起始淨資產 ${fmt(startNW)}（${startKey}）</div>
         </div>`
      : `<div class="pnl-card">
           <div class="pnl-card-label">已實現損益</div>
           <div class="pnl-card-value muted">—</div>
           <div class="pnl-card-sub">無當年快照資料</div>
         </div>`;

    container.innerHTML = `
      <div class="pnl-year-switcher">${switcher}</div>
      <div class="pnl-cards-row">
        <div class="pnl-card">
          <div class="pnl-card-label">總投資市值</div>
          <div class="pnl-card-value">${fmtFull(allInvMV)}</div>
          <div class="pnl-card-sub priv-amt">成本 ${fmtFull(allInvCost)}</div>
        </div>
        <div class="pnl-card">
          <div class="pnl-card-label">總投資標的數</div>
          <div class="pnl-card-value priv-amt">${totalItems}</div>
          <div class="pnl-card-sub priv-amt">${breakdown}</div>
        </div>
        ${pnlCard('未實現損益', unrealized,
            fmtPct(unrealizedPct),
            unrealized >= 0 ? 'profit' : 'loss')}
        ${realizedCard}
        ${total != null
          ? pnlCard('累計損益', total, fmtPct(totalPct), total >= 0 ? 'profit' : 'loss')
          : `<div class="pnl-card"><div class="pnl-card-label">累計損益</div><div class="pnl-card-value muted">—</div><div class="pnl-card-sub">無起始資料</div></div>`}
      </div>`;

  } else {
    // ── Past year: 3 simplified cards ────────────────────────────────
    const snaps = Object.keys(state.history).filter(d => d.startsWith(year + '-')).sort();
    if (snaps.length === 0) {
      container.innerHTML = `<div class="pnl-year-switcher">${switcher}</div>
        <div class="empty-state" style="padding:20px">無 ${year} 年度快照資料</div>`;
      return;
    }
    const startMV = _invMVFromSnap(state.history[snaps[0]]);
    const endMV   = _invMVFromSnap(state.history[snaps.at(-1)]);
    const yearPnL = endMV - startMV;
    const yearPct = startMV > 0 ? yearPnL / startMV * 100 : 0;
    const cls     = yearPnL >= 0 ? 'profit' : 'loss';
    const s       = yearPnL >= 0 ? '+' : '';

    container.innerHTML = `
      <div class="pnl-year-switcher">${switcher}</div>
      <div class="pnl-cards-row">
        <div class="pnl-card">
          <div class="pnl-card-label">${year} 年度總損益</div>
          <div class="pnl-card-value ${cls}">${s}${fmtFull(Math.abs(yearPnL))}</div>
          <div class="pnl-card-sub ${cls}">${s}${fmtPct(yearPct)}</div>
        </div>
        <div class="pnl-card">
          <div class="pnl-card-label">年度損益%</div>
          <div class="pnl-card-value ${cls}">${s}${fmtPct(yearPct)}</div>
          <div class="pnl-card-sub">${snaps[0]} → ${snaps.at(-1)}</div>
        </div>
        <div class="pnl-card">
          <div class="pnl-card-label">年度結算投資市值</div>
          <div class="pnl-card-value">${fmtFull(endMV)}</div>
          <div class="pnl-card-sub">期初 ${fmtFull(startMV)}</div>
        </div>
      </div>`;
  }
}

function renderIndices() {
  const idx = state.indices;
  const items = [
    { key: 'taiex',  name: '加權指數', market: 'tw' },
    { key: 'otc',    name: '櫃買指數', market: 'tw' },
    { key: 'dji',    name: '道瓊指數', market: 'us' },
    { key: 'nasdaq', name: '那斯達克', market: 'us' },
    { key: 'sox',    name: '費半指數', market: 'us' },
    { key: 'btc',    name: '比特幣 (BTC)', market: 'us' },
  ];
  const html = items.map(it => {
    const d = idx[it.key];
    if (!d) return `<div class="index-item"><span class="index-name">${it.name}</span><span class="muted small">—</span></div>`;
    const up = d.change >= 0;
    const arrow = up ? '▲' : '▼';
    const cls = up ? 'index-up' : 'index-down';
    const isBtc = it.key === 'btc';
    const priceStr = isBtc ? `$${Math.round(d.price).toLocaleString()}` : d.price.toLocaleString();
    const changeStr = isBtc
      ? `$${Math.round(Math.abs(d.change)).toLocaleString()} (${Math.abs(d.change_pct).toFixed(2)}%)`
      : `${Math.abs(d.change).toFixed(2)} (${Math.abs(d.change_pct).toFixed(2)}%)`;
    return `<div class="index-item">
      <span class="index-name">${it.name}</span>
      <span class="index-price">${priceStr}</span>
      <span class="index-change ${cls}">${arrow} ${changeStr}</span>
    </div>`;
  }).join('');
  document.getElementById('indices-list').innerHTML = html;

  document.getElementById('fx-info').textContent =
    `USD ${state.usdTwd.toFixed(3)} · JPY ${state.jpyTwd.toFixed(4)}`;
}

// ══ Render: Assets & Liabilities ════════════════════════════════════════
function renderAssetsPage() {
  renderGroupList('assets', 'assets-groups');
  renderGroupList('liabilities', 'liabilities-groups');
}

function renderGroupList(section, containerId) {
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

function renderItemRow(section, gi, ii, item, isLiab) {
  const rowCls = isLiab ? 'group-row group-row-liab' : 'group-row';
  const curOpts = ['TWD', 'USD', 'JPY'].map(c => `<option value="${c}" ${item.currency === c ? 'selected' : ''}>${c}</option>`).join('');
  const twd = toTWD(Number(item.amount) || 0, item.currency);

  if (isLiab) {
    return `<div class="${rowCls}">
      <input value="${escapeAttr(item.name || '')}" placeholder="名稱" onchange="updateItem('${section}',${gi},${ii},'name',this.value)" />
      <input class="num-input priv-num" type="text" inputmode="decimal" value="${item.amount ?? 0}" onchange="updateItem('${section}',${gi},${ii},'amount',parseFloat(this.value)||0)" />
      <select onchange="updateItemCurrency('${section}',${gi},${ii},this.value)">${curOpts}</select>
      <input class="num-input priv-num" type="text" inputmode="decimal" value="${item.rate ?? 1}" onchange="updateItem('${section}',${gi},${ii},'rate',parseFloat(this.value)||1)" />
      <input class="num-input" type="text" inputmode="decimal" value="${item.rate_pct ?? ''}" placeholder="利率%" onchange="updateItem('${section}',${gi},${ii},'rate_pct',parseFloat(this.value)||0)" />
      <input value="${escapeAttr(item.start_date || '')}" placeholder="YYYY/MM" onchange="updateItem('${section}',${gi},${ii},'start_date',this.value)" />
      <input class="num-input" type="text" inputmode="decimal" value="${item.years ?? ''}" placeholder="期數" onchange="updateItem('${section}',${gi},${ii},'years',parseFloat(this.value)||0)" />
      <div class="calc-value red">${fmtFull(twd)}</div>
      <button class="btn-icon" onclick="deleteItem('${section}',${gi},${ii})">✕</button>
    </div>`;
  }

  return `<div class="${rowCls}">
    <input value="${escapeAttr(item.name || '')}" placeholder="名稱" onchange="updateItem('${section}',${gi},${ii},'name',this.value)" />
    <input class="num-input priv-num" type="text" inputmode="decimal" value="${item.amount ?? 0}" onchange="updateItem('${section}',${gi},${ii},'amount',parseFloat(this.value)||0)" />
    <select onchange="updateItemCurrency('${section}',${gi},${ii},this.value)">${curOpts}</select>
    <input class="num-input priv-num" type="text" inputmode="decimal" value="${item.rate ?? 1}" onchange="updateItem('${section}',${gi},${ii},'rate',parseFloat(this.value)||1)" />
    <div class="calc-value">${fmtFull(twd)}</div>
    <button class="btn-icon" onclick="deleteItem('${section}',${gi},${ii})">✕</button>
  </div>`;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ══ CRUD: assets/liabilities items ══════════════════════════════════════
async function updateItem(section, gi, ii, field, value) {
  state.portfolio[section][gi].items[ii][field] = value;
  recalcValue(state.portfolio[section][gi].items[ii]);
  await savePortfolio();
  renderAssetsPage();
  if (currentPage() === 'dashboard') renderDashboard();
}

async function updateItemCurrency(section, gi, ii, currency) {
  const item = state.portfolio[section][gi].items[ii];
  item.currency = currency;
  if (currency === 'TWD') item.rate = 1;
  else if (currency === 'USD') item.rate = state.usdTwd;
  else if (currency === 'JPY') item.rate = state.jpyTwd;
  recalcValue(item);
  await savePortfolio();
  renderAssetsPage();
}

function recalcValue(item) {
  const amt = Number(item.amount) || 0;
  const rate = Number(item.rate) || 1;
  item.value = amt * rate;
}

async function deleteItem(section, gi, ii) {
  if (!confirm('確定刪除此項目？')) return;
  state.portfolio[section][gi].items.splice(ii, 1);
  await savePortfolio();
  renderAssetsPage();
}

async function deleteGroup(section, gi) {
  const g = state.portfolio[section][gi];
  if (!confirm(`確定刪除群組「${g.group}」及其 ${g.items.length} 個項目？`)) return;
  state.portfolio[section].splice(gi, 1);
  await savePortfolio();
  renderAssetsPage();
}

function addItemToGroup(section, gi) {
  state.portfolio[section][gi].items.push({
    name: '新項目', amount: 0, currency: 'TWD', rate: 1, value: 0,
    ...(section === 'liabilities' ? { rate_pct: 0, start_date: '', years: 0 } : {})
  });
  savePortfolio();
  renderAssetsPage();
}

function openAddGroup(section) {
  const name = prompt(`新群組名稱：`);
  if (!name) return;
  state.portfolio[section].push({ group: name, items: [] });
  savePortfolio();
  renderAssetsPage();
}

// ══ Render: Investments ═════════════════════════════════════════════════
function renderInvestmentsPage() {
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

  document.getElementById('inv-title').textContent = groupName;

  // Summary
  let totalMV = 0, totalCost = 0;
  for (const item of items) {
    totalMV += item._mv_twd || 0;
    totalCost += item._cost_twd || 0;
  }
  const pnl = totalMV - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost * 100) : 0;

  document.getElementById('inv-summary').innerHTML = `
    <div class="inv-stat">
      <div class="inv-stat-label">總市值</div>
      <div class="inv-stat-value">${fmtFull(totalMV)}</div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">總成本</div>
      <div class="inv-stat-value">${fmtFull(totalCost)}</div>
    </div>
    <div class="inv-stat">
      <div class="inv-stat-label">損益</div>
      <div class="inv-stat-value ${pnlClass(pnl)}">${pnl >= 0 ? '+' : '-'}${fmtFull(Math.abs(pnl))}&nbsp;<span style="font-size:13px">(${fmtPct(pnlPct)})</span></div>
    </div>
  `;

  // Table
  const isCB = state.currentInv === 'cb';
  const isUS = state.currentInv === 'us';
  const cur = isUS ? 'USD' : 'TWD';

  // CB: hide 預估市值; 今日漲幅% at end of cbHeaders shows underlying stock's change%
  // Non-CB: 今日漲幅% stays after 目前價格
  const baseHeaders = isCB
    ? ['代號', '名稱', '股數', '買入均價', '目前價格', '投入成本', '預估損益', '損益%']
    : ['代號', '名稱', '股數', '買入均價', '目前價格', '今日漲幅%', '投入成本', '預估市值', '預估損益', '損益%'];
  const cbHeaders = ['CB到期日', 'CBAS到期日', '剩餘張數', '餘額%', '轉換價', '溢價率%', '現股價格', '今日漲幅%', '停止轉換'];
  const headers = isCB ? ['★', ...baseHeaders, ...cbHeaders] : baseHeaders;

  // '代號' & '名稱' are non-numeric; everything else is right-aligned
  const numFromIdx = isCB ? 3 : 2;   // ★ shifts the threshold by 1 for CB
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
    const aNum = /^\d/.test(sa), bNum = /^\d/.test(sb);
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    if (aNum && bNum) return sa.localeCompare(sb, undefined, { numeric: true });
    return sa.localeCompare(sb);
  });
  // Map sorted index back to original index for edit/delete ops
  const origIdx = sortedItems.map(item => items.indexOf(item));

  tbody.innerHTML = sortedItems.map((item, si) => {
    const idx = origIdx[si];
    const mv = item._mv || 0;
    const pnl = item._pnl || 0;
    const pnlPct = item._pnl_pct || 0;
    const rowCls = item.highlighted ? 'highlighted' : '';

    const priceCell = (v) => fmtPrice(v);

    // Build a change% cell with optional limit-up/down highlight
    const makeChgCell = (pct) => {
      if (pct == null) return `<td class="num muted">—</td>`;
      const isLimitUp   = pct >=  9.8;
      const isLimitDown = pct <= -9.8;
      const cls = isLimitUp ? 'cell-limit-up' : isLimitDown ? 'cell-limit-down' : pnlClass(pct);
      return `<td class="num ${cls}">${fmtPct(pct)}</td>`;
    };

    const baseCells = `
      <td><span class="symbol-badge">${item.symbol || '—'}</span></td>
      <td>${item.name || '—'}</td>
      <td class="num">${(Number(item.shares) || 0).toLocaleString()}</td>
      <td class="num">${priceCell(item.entry_price)}</td>
      <td class="num">${priceCell(item.current_price)}</td>
      ${isCB ? '' : makeChgCell(item._change_pct)}
      <td class="num">${fmtFull(item.cost).replace('NT$ ', '')}</td>
      ${isCB ? '' : `<td class="num">${fmtFull(mv).replace('NT$ ', '')}</td>`}
      <td class="num ${pnlClass(pnl)}">${pnl >= 0 ? '+' : ''}${fmtFull(pnl).replace('NT$ ', '')}</td>
      <td class="num ${pnlClass(pnlPct)}">${fmtPct(pnlPct)}</td>
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

    const starCell = isCB
      ? `<td><span class="star-btn ${item.highlighted ? 'on' : ''}" onclick="event.stopPropagation(); toggleHighlight(${idx})">${item.highlighted ? '★' : '☆'}</span></td>`
      : '';

    return `<tr class="${rowCls}" onclick="openEditPosition(${idx})" style="cursor:pointer">
      ${starCell}${baseCells}${cbCells}
      <td><button class="btn-icon" onclick="event.stopPropagation(); deletePosition(${idx})">✕</button></td>
    </tr>`;
  }).join('');
}

function switchInvTab(inv) {
  state.currentInv = inv;
  document.querySelectorAll('.inv-tab').forEach(t => t.classList.toggle('active', t.dataset.inv === inv));
  renderInvestmentsPage();
}

async function deletePosition(idx) {
  if (!confirm('確定刪除此部位？')) return;
  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  group.items.splice(idx, 1);
  await savePortfolio();
  calcTotals();
  renderInvestmentsPage();
}

async function toggleHighlight(idx) {
  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  if (!group) return;
  group.items[idx].highlighted = !group.items[idx].highlighted;
  await savePortfolio();
  renderInvestmentsPage();
}

// ══ Position modal ══════════════════════════════════════════════════════
function openAddPosition() { showPositionModal(null); }
function openEditPosition(idx) {
  const groupName = INV_GROUP_MAP[state.currentInv];
  const group = state.portfolio.investments.find(g => g.group === groupName);
  showPositionModal(idx, group.items[idx]);
}

function showPositionModal(idx, item = null) {
  const isCB = state.currentInv === 'cb';
  const isUS = state.currentInv === 'us';
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
      <div class="form-group"><label>買入均價 *</label><input id="f-entry" type="text" inputmode="decimal" value="${v('entry_price')}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>目前價格（存檔後自動更新）</label>
        <input id="f-cur" type="text" inputmode="decimal" value="${v('current_price')}" ${isCB ? 'placeholder="存檔後自動更新"' : ''} /></div>
      <div class="form-group"><label>投入成本 *</label><input id="f-cost" type="text" inputmode="decimal" value="${v('cost')}" /></div>
    </div>
    ${cbFields}
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
    }
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

async function savePosition(idx) {
  const isCB = state.currentInv === 'cb';
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

  const data = {
    symbol: sym,
    name: nameVal,
    shares: num('f-shares'),
    entry_price: num('f-entry'),
    current_price: num('f-cur'),
    cost: num('f-cost'),
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

// ══ Save portfolio ══════════════════════════════════════════════════════
async function savePortfolio() {
  try {
    await api('/api/portfolio', { method: 'POST', body: JSON.stringify(state.portfolio) });
  } catch (e) { console.error(e); toast('儲存失敗', 'error'); }
}

// ══ Snapshot ════════════════════════════════════════════════════════════
async function saveSnapshot() {
  const t = calcTotals();
  const idx = state.indices;
  const body = {
    date: new Date().toISOString().slice(0, 10),
    net_worth: Math.round(t.netWorth),
    total_assets: Math.round(t.totalAssets),
    total_liabilities: Math.round(t.totalDebts),
    asset_groups: Object.fromEntries(
      Object.entries(t.groupTotals).map(([k, v]) => [k, Math.round(v)])
    ),
    taiex: idx.taiex?.price,
    otc: idx.otc?.price,
    dji: idx.dji?.price,
    nasdaq: idx.nasdaq?.price,
    sox: idx.sox?.price,
  };
  try {
    await api('/api/snapshot', { method: 'POST', body: JSON.stringify(body) });
    localStorage.setItem('hc_last_save_time', new Date().toISOString());
    // Reload history so charts & PnL grid reflect the new snapshot immediately
    await loadHistory();
    const page = currentPage();
    if (page === 'growth') renderGrowthChart();
    else if (page === 'trend') renderTrendChart();
    else if (page === 'dashboard') renderPnLGrid(state.pnlYear);
    toast('✅ 資料已儲存');
  } catch (e) { toast('資料儲存失敗', 'error'); }
}

// ══ Refresh all ═════════════════════════════════════════════════════════
async function refreshAll() {
  const icoEl = document.getElementById('refresh-ico');
  const txtEl = document.getElementById('refresh-txt');
  icoEl.innerHTML = '<span class="spinner"></span>';
  txtEl.textContent = '更新中...';

  state._cbSuspensionLoaded = false;
  await loadIndices();
  await refreshPrices();
  await refreshCbSuspensions();  // immediate — don't wait for CB tab visit
  await savePortfolio();
  calcTotals();

  const page = currentPage();
  if (page === 'dashboard') renderDashboard();
  else if (page === 'investments') renderInvestmentsPage();
  else if (page === 'assets') renderAssetsPage();

  icoEl.textContent = '🔄';
  txtEl.textContent = '更新數據';
  toast('✅ 已更新');
}

// ══ Privacy ═════════════════════════════════════════════════════════════
function togglePrivacy() {
  state.privacy = !state.privacy;
  document.body.classList.toggle('privacy', state.privacy);
  document.getElementById('privacy-ico').textContent = state.privacy ? '🔒' : '👁';
  document.getElementById('privacy-txt').textContent = state.privacy ? '隱藏中' : '顯示中';
  const mobileIco = document.getElementById('mobile-privacy-ico');
  if (mobileIco) mobileIco.textContent = state.privacy ? '🙈' : '👁';
}

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isOpen = sidebar.classList.toggle('mobile-open');
  backdrop.classList.toggle('visible', isOpen);
}

// ══ Router ══════════════════════════════════════════════════════════════
function currentPage() {
  const active = document.querySelector('.page.active');
  return active?.id.replace('page-', '') || 'dashboard';
}

function goPage(name) {
  // Close any open modal first to avoid stray dark overlay
  document.getElementById('modal-overlay').classList.add('hidden');

  // Render content BEFORE toggling active so the page is populated during fade-in
  calcTotals();
  if (name === 'dashboard') renderDashboard();
  else if (name === 'assets') renderAssetsPage();
  else if (name === 'investments') renderInvestmentsPage();
  else if (name === 'growth') renderGrowthChart();
  else if (name === 'trend') renderTrendChart();
  else if (name === 'history') renderHistoryPage();
  else if (name === 'important') renderImportantInfo(false);

  // Switch active classes after content is ready
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));

  // Update mobile title and close sidebar
  const titles = {
    dashboard: '資產總覽', assets: '資產與負債', investments: '投資部位',
    growth: '資產成長圖', trend: '資產趨勢圖', history: '歷史紀錄', important: '重要資訊'
  };
  const titleEl = document.getElementById('mobile-page-title');
  if (titleEl) titleEl.textContent = titles[name] || name;
  // Close sidebar on mobile after navigation
  document.querySelector('.sidebar').classList.remove('mobile-open');
  const bd = document.getElementById('sidebar-backdrop');
  if (bd) bd.classList.remove('visible');
}

// ══ Growth Chart ════════════════════════════════════════════════════════
async function renderGrowthChart() {
  // Load history if empty
  if (Object.keys(state.history).length === 0) {
    await loadHistory();
  }

  const dates = Object.keys(state.history).sort();
  if (dates.length === 0) {
    document.querySelector('#growth-chart').parentElement.innerHTML =
      '<div class="empty-state">尚無歷史資料，點擊「💾 儲存資料」開始記錄</div>';
    return;
  }

  // Date range pickers — default: Jan 1 of current year
  const startEl = document.getElementById('growth-start');
  const endEl   = document.getElementById('growth-end');
  if (!startEl.value) startEl.value = new Date().getFullYear() + '-01-01';
  if (!endEl.value)   endEl.value   = dates[dates.length - 1];
  const start = startEl.value;
  const end   = endEl.value;

  // Filter
  const filtered = dates.filter(d => d >= start && d <= end);
  if (filtered.length === 0) {
    document.querySelector('#growth-chart').parentElement.innerHTML =
      '<div class="empty-state">所選範圍內無資料</div>';
    return;
  }

  // Collect all asset group names across range
  const allGroups = new Set();
  for (const d of filtered) {
    const g = state.history[d].asset_groups;
    if (g) Object.keys(g).forEach(k => allGroups.add(k));
  }
  // Order: fixed priority with known groups first, then extras
  const priority = ['現金', '不動產', '其他', '股票', '可轉債', '美國股市'];
  const groupList = [
    ...priority.filter(g => allGroups.has(g)),
    ...[...allGroups].filter(g => !priority.includes(g)),
  ];

  const colorMap = {
    '現金':     '#22d3ee',   // 亮藍青
    '不動產':   '#c084fc',   // 亮紫
    '其他':     '#94a3b8',   // 淺灰藍
    '股票':     '#4ade80',   // 亮綠
    '可轉債':   '#fbbf24',   // 亮黃
    '美國股市': '#f97316',   // 亮橙
  };

  // Build datasets — each asset group is a stacked bar series
  const toWan = v => v / 1e4;

  const stackedDatasets = groupList.map((g, i) => ({
    label: g,
    data: filtered.map(d => {
      const ag = state.history[d].asset_groups;
      return ag ? toWan(ag[g] || 0) : 0;
    }),
    backgroundColor: colorMap[g] || CHART_COLORS[i % CHART_COLORS.length],
    borderColor: 'transparent',
    stack: 'assets',
    borderRadius: 2,
    barPercentage: 0.85,
    categoryPercentage: 0.9,
  }));

  // Net worth line overlay
  const netWorthLine = {
    type: 'line',
    label: '淨資產',
    data: filtered.map(d => toWan(state.history[d].net_worth || 0)),
    borderColor: '#ffffff',
    backgroundColor: 'rgba(255,255,255,.08)',
    borderWidth: 4,
    pointRadius: filtered.length > 60 ? 0 : 3,
    pointHoverRadius: 6,
    tension: 0.35,
    fill: false,
    yAxisID: 'y',
    order: 0,
  };

  // Liabilities line — distinct magenta/pink, thick
  const liabLine = {
    type: 'line',
    label: '總負債',
    data: filtered.map(d => toWan(state.history[d].total_liabilities || 0)),
    borderColor: '#f43f5e',
    backgroundColor: '#f43f5e',
    borderWidth: 3,
    borderDash: [6, 3],
    pointRadius: filtered.length > 60 ? 0 : 3,
    pointHoverRadius: 5,
    tension: 0.35,
    fill: false,
    yAxisID: 'y',
    order: 0,
  };

  // Summary stats
  const first = state.history[filtered[0]];
  const last  = state.history[filtered[filtered.length - 1]];
  const nwChange = (last.net_worth || 0) - (first.net_worth || 0);
  const nwPct = first.net_worth > 0 ? (nwChange / first.net_worth * 100) : 0;
  const daysSpan = filtered.length;

  document.getElementById('growth-summary').innerHTML = `
    <div class="pnl-card">
      <div class="pnl-card-label">期間淨資產變化</div>
      <div class="pnl-card-value ${pnlClass(nwChange)}">${nwChange >= 0 ? '+' : ''}${fmtFull(Math.abs(nwChange))}</div>
      <div class="pnl-card-sub ${pnlClass(nwPct)}">${fmtPct(nwPct)} (${daysSpan} 筆資料)</div>
    </div>
    <div class="pnl-card">
      <div class="pnl-card-label">起始淨資產</div>
      <div class="pnl-card-value">${fmtFull(first.net_worth)}</div>
      <div class="pnl-card-sub">${filtered[0]}</div>
    </div>
    <div class="pnl-card">
      <div class="pnl-card-label">目前淨資產</div>
      <div class="pnl-card-value">${fmtFull(last.net_worth)}</div>
      <div class="pnl-card-sub">${filtered[filtered.length - 1]}</div>
    </div>
  `;

  // Render chart
  const ctx = document.getElementById('growth-chart').getContext('2d');
  if (charts.growth) charts.growth.destroy();

  charts.growth = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: filtered,
      datasets: [netWorthLine, liabLine, ...stackedDatasets],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: '#e8ecf6', padding: 14, usePointStyle: true, font: { size: 12 } },
        },
        tooltip: {
          backgroundColor: '#1a2547',
          borderColor: '#334b82',
          borderWidth: 1,
          titleColor: '#e8ecf6',
          bodyColor: '#a7b0c8',
          padding: 12,
          callbacks: {
            label: (c) => {
              const v = c.raw * 1e4;
              return ` ${c.dataset.label}: ${fmtFull(v)}`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: '#a7b0c8', maxTicksLimit: 14, font: { size: 11 } },
          grid: { display: false },
        },
        y: {
          // NOTE: do NOT set stacked:true here — that would stack line datasets
          // on top of bar totals. Bars stack via their per-dataset stack:'assets'.
          ticks: {
            color: '#a7b0c8',
            callback: v => v.toLocaleString() + ' 萬',
          },
          grid: { color: 'rgba(255,255,255,.05)' },
        },
      }
    }
  });
}

// ══ Trend Chart ═════════════════════════════════════════════════════════
async function renderTrendChart() {
  // Use daily snapshots from history.json (alm_history)
  if (Object.keys(state.history).length === 0) {
    await loadHistory();
  }

  const allDates = Object.keys(state.history).sort();
  if (allDates.length === 0) {
    document.querySelector('#trend-chart').parentElement.innerHTML =
      '<div class="empty-state">尚無歷史資料，點擊「💾 儲存資料」開始記錄</div>';
    return;
  }

  const startEl = document.getElementById('trend-start');
  const endEl = document.getElementById('trend-end');
  if (!startEl.value) startEl.value = new Date().getFullYear() + '-01-01';
  if (!endEl.value) endEl.value = allDates[allDates.length - 1];

  const start = startEl.value;
  const end = endEl.value;

  const filtered = allDates.filter(d => d >= start && d <= end);
  if (filtered.length < 2) {
    document.querySelector('#trend-chart').parentElement.innerHTML =
      '<div class="empty-state">所選範圍內資料不足 (至少需要 2 筆)</div>';
    return;
  }

  const labels = filtered;
  const first = state.history[filtered[0]];

  // 6 series: personal net worth + 5 market indices
  const series = [
    { key: 'net_worth', label: '個人淨資產', color: '#06b6d4', width: 3, fill: true, dash: [] },
    { key: 'taiex',     label: '加權指數',   color: '#f97316', width: 2, fill: false, dash: [6, 4] },
    { key: 'otc',       label: '櫃買指數',   color: '#34d399', width: 2, fill: false, dash: [4, 3] },
    { key: 'nasdaq',    label: '那斯達克',   color: '#a855f7', width: 2, fill: false, dash: [8, 4] },
    { key: 'sox',       label: '費半指數',   color: '#ec4899', width: 2, fill: false, dash: [3, 3] },
    { key: 'dji',       label: '道瓊指數',   color: '#3b82f6', width: 2, fill: false, dash: [6, 2] },
  ];

  const datasets = series.map(s => {
    const base = first[s.key];
    const data = filtered.map(d => {
      const v = state.history[d][s.key];
      return (base && v) ? ((v - base) / base * 100) : null;
    });
    return {
      label: s.label,
      data,
      borderColor: s.color,
      backgroundColor: s.fill ? s.color.replace(')', ',.1)').replace('rgb', 'rgba').replace('#', '') : 'transparent',
      ...(s.fill ? { backgroundColor: hexToRgba(s.color, 0.1), fill: true } : { fill: false }),
      borderWidth: s.width,
      borderDash: s.dash,
      tension: 0.3,
      pointRadius: filtered.length > 60 ? 0 : 3,
      pointHoverRadius: 5,
      spanGaps: true,
    };
  });

  const ctx = document.getElementById('trend-chart').getContext('2d');
  if (charts.trend) charts.trend.destroy();

  charts.trend = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#e8ecf6', padding: 14, usePointStyle: true, font: { size: 12 } },
        },
        tooltip: {
          backgroundColor: '#1a2547',
          borderColor: '#334b82',
          borderWidth: 1,
          titleColor: '#e8ecf6',
          bodyColor: '#a7b0c8',
          padding: 12,
          callbacks: { label: c => ` ${c.dataset.label}: ${c.raw != null ? fmtPct(c.raw) : '—'}` }
        }
      },
      scales: {
        x: { ticks: { color: '#a7b0c8', maxTicksLimit: 14, font: { size: 11 } }, grid: { color: 'rgba(255,255,255,.04)' } },
        y: { ticks: { color: '#a7b0c8', callback: v => v.toFixed(0) + '%' }, grid: { color: 'rgba(255,255,255,.06)' } }
      }
    }
  });
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ══ History Page ════════════════════════════════════════════════════════
function renderHistoryPage() {
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

async function addManualHistory() {
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

async function deleteManualHistory(date) {
  if (!confirm(`刪除 ${date} 的紀錄？`)) return;
  await api('/api/manual-history/' + date, { method: 'DELETE' });
  await loadManualHistory();
  renderHistoryPage();
}

// ══ Settings Modal ═════════════════════════════════════════════════════
function openSettingsModal() {
  document.getElementById('modal-title').textContent = '⚙️ 統計設定';

  const sections = [
    { key: 'assets',       label: '📗 資產', groups: state.portfolio.assets },
    { key: 'investments',  label: '📈 投資', groups: state.portfolio.investments },
    { key: 'liabilities',  label: '📕 負債', groups: state.portfolio.liabilities },
  ];

  let html = '<div class="settings-sections">';
  for (const sec of sections) {
    html += `<div class="settings-section"><h4>${sec.label}</h4>`;
    sec.groups.forEach((g, gi) => {
      const gk = groupKey(sec.key, gi);
      const gChecked = !state.excluded.has(gk);
      html += `<div class="check-row check-row-group">
        <input type="checkbox" id="chk-${sec.key}-${gi}" ${gChecked ? 'checked' : ''}
          onchange="toggleGroup('${sec.key}',${gi},this.checked)" />
        <label for="chk-${sec.key}-${gi}"><strong>${g.group}</strong></label>
      </div>`;
      g.items.forEach((item, ii) => {
        const ik = itemKey(sec.key, gi, ii);
        const iChecked = !state.excluded.has(ik) && gChecked;
        const name = item.name || item.symbol || `項目 ${ii + 1}`;
        const val = sec.key === 'investments'
          ? (item._mv_twd != null ? fmtFull(item._mv_twd) : '')
          : (item._twd != null ? fmtFull(item._twd) : '');
        html += `<div class="check-row check-row-item" style="padding-left:32px">
          <input type="checkbox" id="chk-${sec.key}-${gi}-${ii}" ${iChecked ? 'checked' : ''}
            ${!gChecked ? 'disabled' : ''}
            onchange="toggleItem('${sec.key}',${gi},${ii},this.checked)" />
          <label for="chk-${sec.key}-${gi}-${ii}">${escapeAttr(name)}</label>
          <span class="muted small" style="margin-left:auto">${val}</span>
        </div>`;
      });
    });
    html += '</div>';
  }
  html += '</div>';
  html += `<div class="modal-footer">
    <button class="btn-primary" onclick="closeModal()">完成</button>
  </div>`;

  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function toggleGroup(section, gi, checked) {
  const gk = groupKey(section, gi);
  if (checked) {
    state.excluded.delete(gk);
  } else {
    state.excluded.add(gk);
  }
  saveExcluded();
  calcTotals();
  renderDashboard();
  openSettingsModal(); // re-render to update child checkboxes
}

function toggleItem(section, gi, ii, checked) {
  const ik = itemKey(section, gi, ii);
  if (checked) {
    state.excluded.delete(ik);
  } else {
    state.excluded.add(ik);
  }
  saveExcluded();
  calcTotals();
  renderDashboard();
}

// ══ Modal ═══════════════════════════════════════════════════════════════
function closeModal(event) {
  if (!event || event.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
}

// ══ Init ════════════════════════════════════════════════════════════════
async function init() {
  // Nav click handlers
  document.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', () => goPage(n.dataset.page));
  });
  document.querySelectorAll('.inv-tab').forEach(t => {
    t.addEventListener('click', () => switchInvTab(t.dataset.inv));
  });

  // Time display
  const updateTime = () => {
    const now = new Date();
    document.getElementById('datetime').textContent =
      now.getFullYear() + '/' +
      String(now.getMonth() + 1).padStart(2, '0') + '/' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');
  };
  updateTime();
  setInterval(updateTime, 30000);

  // Load data
  await loadPortfolio();
  await loadManualHistory();
  await loadHistory();
  await loadIndices();
  calcTotals();
  renderDashboard();

  // Fetch prices in background
  refreshPrices().then(() => {
    calcTotals();
    if (currentPage() === 'dashboard') renderDashboard();
    if (currentPage() === 'investments') renderInvestmentsPage();
  });
}

init();

// ══ Important Info ═════════════════════════════════════════════════════
function _importantMetricFailed(metric) {
  if (!metric) return true;
  // price-style metric {price, change, change_pct}
  if ('price' in metric) return metric.price === '-' || metric.price == null;
  // current-style metric {current, prev}
  if ('current' in metric) return metric.current === null || metric.current === undefined;
  // balance-style metric {balance, increase}
  if ('balance' in metric) return metric.balance === null || metric.balance === undefined;
  return true;
}

function _importantChangeColor(val) {
  if (val == null) return '';
  const s = String(val);
  const num = parseFloat(s.replace(/[+%,]/g, ''));
  if (isNaN(num)) return '';
  if (num > 0) return 'var(--green)';
  if (num < 0) return 'var(--red)';
  return '';
}

const _importantCache = { ts: 0, data: null };
const IMPORTANT_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours in ms

async function renderImportantInfo(force = false) {
  const tbody = document.getElementById('important-tbody');
  if(!tbody) return;

  const nowMs = Date.now();
  const cacheValid = !force && _importantCache.data && (nowMs - _importantCache.ts) < IMPORTANT_CACHE_TTL;

  if (!cacheValid) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px;">⏳ 正在抓取最新市場數據...</td></tr>';
  }

  try {
    let data;
    if (cacheValid) {
      data = _importantCache.data;
    } else {
      data = await api('/api/important-info' + (force ? '?force=true' : ''));
      _importantCache.data = data;
      _importantCache.ts = nowMs;
    }
    const fetchTime = new Date(_importantCache.ts).toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit', second:'2-digit'});

    // changeKey: which field to derive arrow color from (null = no coloring)
    const rows = [
      { name: '📈 台指期盤後 (WTX&)', src: 'Yahoo TW',
        metric: data.wtx,
        fmt: o => o.price,
        sub: o => `${o.change} (${o.change_pct})`,
        changeKey: 'change' },

      { name: '📈 富台指 (TWNCON)', src: '鉅亨',
        metric: data.twncon,
        fmt: o => o.price,
        sub: o => `${o.change} (${o.change_pct})`,
        changeKey: 'change' },

      { name: '🇺🇸 台積電 ADR (TSM)', src: 'Yahoo Finance',
        metric: data.tsm_adr,
        fmt: o => `$${o.price}`,
        sub: o => `${o.change} (${o.change_pct})`,
        changeKey: 'change' },

      { name: '🇹🇼 上市融資餘額', src: 'TWSE',
        metric: data.margin_balance_tse,
        fmt: o => `${o.balance} 億`,
        sub: o => `${Number(o.increase) >= 0 ? '+' : ''}${o.increase} 億`,
        changeKey: 'increase' },

      { name: '🇹🇼 上櫃融資餘額', src: 'TPEX',
        metric: data.margin_balance_otc,
        fmt: o => `${o.balance} 億`,
        sub: o => `${Number(o.increase) >= 0 ? '+' : ''}${o.increase} 億`,
        changeKey: 'increase' },

      { name: '🇹🇼 台股大盤融資維持率', src: 'MacroMicro',
        metric: data.taiex_margin_ratio,
        fmt: o => `${o.current}%`,
        sub: o => {
          const chg = o.prev != null ? Math.round((o.current - o.prev) * 100) / 100 : null;
          const sign = chg != null ? (chg >= 0 ? '+' : '') : '';
          return o.prev != null ? `${o.prev}% (${sign}${chg}%)` : '—';
        },
        colorFn: o => o.current - o.prev },

      { name: '🇺🇸 美國10年期公債殖利率', src: 'Yahoo Finance',
        metric: data.us_10y_bond,
        fmt: o => `${o.current}%`,
        sub: o => o.change ? `${o.change} (${o.change_pct})` : `前值: ${o.prev}%`,
        changeKey: 'change' },

      { name: '🛢 布蘭特原油 (Brent)', src: 'Yahoo Finance',
        metric: data.brent,
        fmt: o => `$${o.current}`,
        sub: o => o.change ? `${o.change} (${o.change_pct})` : `前值: $${o.prev}`,
        changeKey: 'change' },
    ];

    let html = '';
    for (const r of rows) {
      if (_importantMetricFailed(r.metric)) {
        html += `<tr>
          <td style="font-weight:600">${r.name}</td>
          <td class="muted">—</td>
          <td class="muted small">讀取失敗</td>
        </tr>`;
        continue;
      }

      let v1, v2;
      try { v1 = r.fmt(r.metric); v2 = r.sub(r.metric); }
      catch(_) {
        html += `<tr>
          <td style="font-weight:600">${r.name}</td>
          <td class="muted">—</td>
          <td class="muted small">讀取失敗</td>
        </tr>`;
        continue;
      }

      const changeVal = r.colorFn ? r.colorFn(r.metric) : (r.changeKey ? r.metric[r.changeKey] : null);
      const subColor = _importantChangeColor(changeVal);

      html += `<tr>
        <td style="font-weight:600">${r.name}</td>
        <td style="font-size:15px; font-weight:600; font-family:'JetBrains Mono',monospace">${v1}</td>
        <td style="color:${subColor}; font-weight:500; font-family:'JetBrains Mono',monospace">${v2}</td>
      </tr>`;
    }

    // Footer row with update time
    html += `<tr style="border-top:1px solid var(--border)">
      <td colspan="3" class="muted small" style="text-align:right; padding:8px 12px">
        資料更新時間: ${fetchTime}${cacheValid ? '（快取）' : ''}
      </td>
    </tr>`;

    tbody.innerHTML = html;
  } catch(e) {
    console.error(e);
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--danger)">❌ 資料載入失敗</td></tr>';
  }
}