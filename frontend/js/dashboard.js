// 資產總覽 (dashboard) page + totals calculation.

import { loadHistory, savePortfolio } from './api.js';
import { CHART_COLORS, adjSnap, charts, getExcludedGroupNames, isExcluded, state } from './state.js';
import { fmt, fmtFull, fmtPct, localISODate, toTWD } from './utils.js';

// ══ Calculations ════════════════════════════════════════════════════════
export function calcTotals() {
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
  let totalInvPnL = 0;   // Σ item._pnl_twd — correct regardless of margin
  let totalStockMargin = 0;  // sum of margin_amount from TW stocks
  for (let gi = 0; gi < p.investments.length; gi++) {
    const g = p.investments[gi];
    let groupSum = 0;
    let groupCost = 0;
    for (let ii = 0; ii < g.items.length; ii++) {
      const item = g.items[ii];
      const isCB    = g.group === '可轉債';
      const isUS    = g.group === '美國股市';
      const isTWSt  = g.group === '股票';
      const price   = Number(item.current_price) || 0;
      const cost    = Number(item.cost) || 0;          // 自備款 (user-entered out-of-pocket)
      const margin  = isTWSt ? (Number(item.margin_amount) || 0) : 0;  // 融資借款
      const shares  = Number(item.shares) || 0;
      const entry   = Number(item.entry_price) || 0;

      let mv;
      if (isCB) {
        mv = cost + (price - entry) * shares;
      } else {
        mv = shares * price;
      }
      const mvTWD   = isUS ? mv * state.usdTwd : mv;
      const costTWD = isUS ? cost * state.usdTwd : cost;

      item._mv       = mv;
      item._mv_twd   = mvTWD;
      item._cost_twd = costTWD;
      item._margin   = margin;
      item._pnl      = (price - entry) * shares;
      item._pnl_twd  = isUS ? item._pnl * state.usdTwd : item._pnl;
      // 損益%: cost = 自備款，直接當分母，反映融資槓桿後的報酬率
      item._pnl_pct  = cost > 0 ? (item._pnl / cost * 100) : 0;

      if (!isExcluded('investments', gi, ii)) {
        groupSum   += mvTWD;
        groupCost  += costTWD;
        totalInvPnL += item._pnl_twd;
        if (isTWSt) totalStockMargin += margin;
      }
    }
    groupTotals[g.group] = groupSum;
    totalAssets     += groupSum;
    totalInvestment += groupSum;
    totalInvCost    += groupCost;
  }

  // Auto-sync 股票融資 into liabilities (in-memory only; persisted on next savePortfolio)
  _syncMarginLiability(p, totalStockMargin);

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

  const netWorth  = totalAssets - totalDebts;
  const leverage  = netWorth > 0 ? totalAssets / netWorth : 0;
  const exposure  = netWorth > 0 ? (totalInvestment / netWorth * 100) : 0;
  // Use Σ _pnl_twd so margin doesn't inflate the P&L figure
  const invPnL    = totalInvPnL;
  const invPnLPct = totalInvCost > 0 ? (invPnL / totalInvCost * 100) : 0;

  return { totalAssets, totalDebts, netWorth, leverage, exposure,
           totalInvestment, totalInvCost, invPnL, invPnLPct, groupTotals };
}

// Auto-manage "股票融資" entry in liabilities based on TW stock margin_amount sum
export function _syncMarginLiability(portfolio, totalMargin) {
  const MARGIN_ITEM_NAME = '股票融資';
  const MARGIN_GROUP     = '短期貸款';
  let group = portfolio.liabilities.find(g => g.group === MARGIN_GROUP);
  if (!group) {
    // Create the group if it doesn't exist yet
    group = { group: MARGIN_GROUP, items: [] };
    portfolio.liabilities.push(group);
  }
  const idx = group.items.findIndex(i => i._auto_margin);
  if (totalMargin > 0) {
    const entry = { name: MARGIN_ITEM_NAME, amount: totalMargin, currency: 'TWD', rate: 1, _auto_margin: true, _twd: totalMargin };
    if (idx >= 0) Object.assign(group.items[idx], entry);
    else          group.items.push(entry);
  } else if (idx >= 0) {
    group.items.splice(idx, 1);  // remove when no margin
  }
}


// ══ Render: Dashboard ═══════════════════════════════════════════════════
export function renderDashboard() {
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

  renderPnLGrid();  // async; also triggers renderDashboardTrendChart internally

  document.getElementById('dash-time').textContent = '更新於 ' + new Date().toLocaleString('zh-TW');
}

export async function renderDashboardTrendChart(year) {
  if (Object.keys(state.history).length === 0) await loadHistory();

  const canvas = document.getElementById('trend-chart-new');
  if (!canvas) return;

  const curYear = new Date().getFullYear();
  if (year == null) year = state.pnlYear ?? curYear;
  const todayStr = localISODate();

  const historyWithToday = { ...state.history };
  if (year === curYear) {
    const t = calcTotals();
    historyWithToday[todayStr] = {
      net_worth: t.netWorth,
      total_assets: t.totalAssets,
      total_liabilities: t.totalDebts,
    };
  }

  const startDate = `${year}-01-01`;
  const endDate   = year === curYear ? todayStr : `${year + 1}-01-01`;

  const dates = Object.keys(historyWithToday)
    .filter(d => !d.startsWith('_') && d >= startDate && d <= endDate)
    .sort();
  
  if (dates.length === 0) return;

  // For current year: group by month (many daily entries); past years: already monthly
  const monthGroups = {};
  for (const d of dates) {
    const yyyymm = d.slice(0, 7);
    if (!monthGroups[yyyymm]) monthGroups[yyyymm] = [];
    monthGroups[yyyymm].push(d);
  }
  const plotDates = Object.keys(monthGroups).sort()
    .map(ym => monthGroups[ym].sort().at(-1));

  if (charts.dashboardTrend) { charts.dashboardTrend.destroy(); charts.dashboardTrend = null; }

  const ctx = canvas.getContext('2d');
  const toM = v => +(v / 1e6).toFixed(3);
  const labels = plotDates.map(d => {
    const [y, m] = d.split('-');
    return year === curYear ? `${y}.${+m}` : `${+m}月`;
  });

  const mk = (label, color, key) => ({
    label, borderColor: color,
    backgroundColor: color.replace(')', ', 0.08)').replace('rgb', 'rgba'),
    data: plotDates.map(d => toM(historyWithToday[d][key] ?? historyWithToday[d].total_debts ?? 0)),
    borderWidth: 2, tension: 0.2, pointRadius: 3, pointHoverRadius: 5, fill: false,
  });

  charts.dashboardTrend = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        mk('總資產', '#3b82f6', 'total_assets'),
        mk('淨資產', '#10b981', 'net_worth'),
        mk('總負債', '#ef4444', 'total_liabilities'),
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { color: '#a7b0c8', font: {size:12}, boxWidth:12, boxHeight:12, useBorderRadius:true, borderRadius:6 } },
        tooltip: {
          backgroundColor: '#1a2547', borderColor: '#334b82', borderWidth: 1,
          titleColor: '#e8ecf6', bodyColor: '#a7b0c8',
          callbacks: { label: c => ` ${c.dataset.label}: ${c.raw.toFixed(2)} 百萬` }
        },
        datalabels: { display: false },
      },
      scales: {
        x: { grid: {color:'rgba(255,255,255,0.04)'}, ticks: {color:'#a7b0c8', font:{size:11}} },
        y: {
          grid: {color:'rgba(255,255,255,0.04)'},
          ticks: {color:'#a7b0c8', font:{size:11}},
          title: {display:true, text:'百萬 TWD', color:'#6b7694', font:{size:11}},
        }
      }
    }
  });
}

// ══ PnL Grid (year-based) ════════════════════════════════════════════════
export const _INV_HIST_GROUPS = ['股票', '可轉債', '美國股市'];

export function _invMVFromSnap(snap) {
  if (!snap) return 0;
  if (!snap.asset_groups) return snap.net_worth ?? snap.total_assets ?? 0;
  const exNames = getExcludedGroupNames();
  return _INV_HIST_GROUPS.reduce((s, g) => exNames.has(g) ? s : s + (snap.asset_groups[g] || 0), 0);
}

export async function renderPnLGrid(year) {
  if (year != null) state.pnlYear = year;
  const curYear = new Date().getFullYear();
  year = state.pnlYear;

  if (Object.keys(state.history).length === 0) await loadHistory();

  const allHistYears = [...new Set(
    Object.keys(state.history)
      .map(d => +d.slice(0, 4))
      .filter(y => !isNaN(y) && y > 2000)
  )].sort();
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
    let allInvMV = 0, allInvCost = 0, allInvPnL = 0, allMargin = 0;
    state.portfolio.investments.forEach((g, gi) => {
      const isTWSt = g.group === '股票';
      g.items.forEach((item, ii) => {
        if (isExcluded('investments', gi, ii)) return;
        allInvMV   += item._mv_twd  || 0;
        allInvCost += item._cost_twd || 0;
        allInvPnL  += item._pnl_twd || 0;
        if (isTWSt) allMargin += item._margin || 0;
      });
    });
    const allTotalCost  = allInvCost + allMargin;   // 自備款 + 融資 = 總買入成本
    const unrealized    = allInvPnL;                // 正確：不受融資金額影響
    const unrealizedPct = allTotalCost > 0 ? unrealized / allTotalCost * 100 : 0;

    // Find current year's first snapshot → starting net worth
    const curYearSnaps = Object.keys(state.history)
      .filter(d => d.startsWith(year + '-')).sort();
    const startKey  = curYearSnaps[0];
    const startNW   = startKey ? (adjSnap(state.history[startKey]).net_worth || 0) : 0;

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
          <div class="pnl-card-sub priv-amt">成本 ${fmtFull(allTotalCost)}${allMargin > 0 ? `（含融資 ${fmtFull(allMargin)}）` : ''}</div>
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
    const startKey = `${year}-01-01`;
    const endKey   = `${year + 1}-01-01`;
    const startSnap = state.history[startKey];
    const endSnap   = state.history[endKey];
    if (!startSnap || !endSnap) {
      container.innerHTML = `<div class="pnl-year-switcher">${switcher}</div>
        <div class="empty-state" style="padding:20px">缺少 ${startKey} 或 ${endKey} 快照資料</div>`;
      return;
    }
    const hasGroups = !!(startSnap?.asset_groups && endSnap?.asset_groups);
    const _nw = s => s.net_worth ?? s.total_assets ?? 0;
    const startMV = hasGroups ? _invMVFromSnap(startSnap) : _nw(startSnap);
    const endMV   = hasGroups ? _invMVFromSnap(endSnap)   : _nw(endSnap);
    const yearPnL = endMV - startMV;
    const yearPct = startMV > 0 ? yearPnL / startMV * 100 : 0;
    const cls     = yearPnL >= 0 ? 'profit' : 'loss';
    const s       = yearPnL >= 0 ? '+' : '';
    const mvLabel = hasGroups ? '年度結算投資市值' : '年度結算淨資產';
    const note    = hasGroups ? `期初 ${fmtFull(startMV)}` : `期初 ${fmtFull(startMV)}（以淨資產估算）`;

    container.innerHTML = `
      <div class="pnl-year-switcher">${switcher}</div>
      <div class="pnl-cards-row">
        <div class="pnl-card">
          <div class="pnl-card-label">${year} 年度總損益</div>
          <div class="pnl-card-value ${cls}">${s}${fmtFull(Math.abs(yearPnL))}</div>
        </div>
        <div class="pnl-card">
          <div class="pnl-card-label">年度損益%</div>
          <div class="pnl-card-value ${cls}">${fmtPct(yearPct)}</div>
          <div class="pnl-card-sub">${startKey} → ${endKey}</div>
        </div>
        <div class="pnl-card">
          <div class="pnl-card-label">${mvLabel}</div>
          <div class="pnl-card-value">${fmtFull(endMV)}</div>
          <div class="pnl-card-sub">${note}</div>
        </div>
      </div>`;
  }
  renderDashboardTrendChart(year);
}

export function renderIndices() {
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
