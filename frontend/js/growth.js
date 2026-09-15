// 資產成長圖 (growth/trend charts) page.

import { loadHistory } from './api.js';
import { hexToRgba, minMaxPlugin } from './charts.js';
import { CHART_COLORS, adjSnap, charts, getExcludedGroupNames, state } from './state.js';
import { fmtFull, fmtPct, localISODate, pnlClass } from './utils.js';

// ── Date range shortcuts for Growth / Trend charts ──────────────────────────
export function _setChartAll() {
  document.getElementById('growth-start').value = '2020-01-01';
  document.getElementById('growth-end').value = localISODate();
  renderGrowthChart(); renderTrendChart();
}

export function _setChartYear(yr) {
  const today = localISODate();
  const curYear = new Date().getFullYear();
  document.getElementById('growth-start').value = `${yr}-01-01`;
  document.getElementById('growth-end').value = yr >= curYear ? today : `${yr + 1}-01-01`;
  renderGrowthChart(); renderTrendChart();
}

export function _setChartRange(prefix, type) {
  const now = new Date();
  const today = localISODate(now);
  const y = now.getFullYear();
  const mo = now.getMonth(); // 0-based
  let start, end = today;
  if (type === 'day') {
    const prev = new Date(now);
    prev.setDate(prev.getDate() - 1);
    start = localISODate(prev);                       // 前一日收盤
  } else if (type === 'week') {
    const dow = (now.getDay() + 6) % 7;              // days since Monday
    const monday = new Date(now);
    monday.setDate(now.getDate() - dow);              // 本週一
    start = localISODate(monday);
  } else if (type === 'month') {
    start = `${y}-${String(mo + 1).padStart(2, '0')}-01`;   // 本月1號
  } else if (type === 'prevmonth') {
    const pm = new Date(y, mo, 0);                   // last day of prev month
    const pmy = pm.getFullYear();
    const pmm = String(pm.getMonth() + 1).padStart(2, '0');
    start = `${pmy}-${pmm}-01`;
    end   = `${pmy}-${pmm}-${String(pm.getDate()).padStart(2, '0')}`;
  } else { // year
    start = `${y}-01-01`;
  }
  document.getElementById('growth-start').value = start;
  document.getElementById('growth-end').value = end;
  renderGrowthChart();
  renderTrendChart();
}

// ══ Growth Chart ════════════════════════════════════════════════════════
export async function renderGrowthChart() {
  // Load history if empty
  if (Object.keys(state.history).length === 0) {
    await loadHistory();
  }

  const chartContainer = document.getElementById('growth-chart-container');
  const summaryEl      = document.getElementById('growth-summary');
  const today          = localISODate();

  const _showEmpty = (msg) => {
    if (chartContainer) chartContainer.style.display = 'none';
    if (summaryEl) summaryEl.innerHTML = `<div class="empty-state">${msg}</div>`;
  };
  const _showChart = () => {
    if (chartContainer) chartContainer.style.display = '';
  };

  const dates = Object.keys(state.history).sort();
  if (dates.length === 0) {
    _showEmpty('尚無歷史資料，點擊「💾 儲存資料」開始記錄');
    return;
  }

  // Date range pickers — default: Jan 1 of current year → today
  const startEl = document.getElementById('growth-start');
  const endEl   = document.getElementById('growth-end');
  if (!startEl.value) startEl.value = new Date().getFullYear() + '-01-01';
  if (!endEl.value)   endEl.value   = today;
  const start = startEl.value;
  const end   = endEl.value;

  // Filter
  const filtered = dates.filter(d => d >= start && d <= end);
  if (filtered.length === 0) {
    _showEmpty('所選範圍內無資料');
    return;
  }

  _showChart();

  // Collect all asset group names across range (excluding currently excluded groups)
  const _exNamesGrowth = getExcludedGroupNames();
  const allGroups = new Set();
  for (const d of filtered) {
    const g = state.history[d].asset_groups;
    if (g) Object.keys(g).filter(k => !_exNamesGrowth.has(k)).forEach(k => allGroups.add(k));
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
    data: filtered.map(d => toWan(adjSnap(state.history[d]).net_worth || 0)),
    borderColor: '#ffffff',
    backgroundColor: 'rgba(255,255,255,.08)',
    borderWidth: 4,
    pointRadius: filtered.length > 60 ? 0 : 3,
    pointHoverRadius: 6,
    tension: 0.35,
    fill: false,
    yAxisID: 'y',
    order: 0,
    _minMaxFmt: v => (v * 1e4 / 1e4).toLocaleString('zh-TW', {maximumFractionDigits: 0}) + ' 萬',
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
    _minMaxFmt: v => (v * 1e4 / 1e4).toLocaleString('zh-TW', {maximumFractionDigits: 0}) + ' 萬',
  };

  // Summary stats
  const first = adjSnap(state.history[filtered[0]]);
  const last  = adjSnap(state.history[filtered[filtered.length - 1]]);
  const nwChange = (last.net_worth || 0) - (first.net_worth || 0);
  const nwPct = first.net_worth > 0 ? (nwChange / first.net_worth * 100) : 0;
  const daysSpan = filtered.length;

  document.getElementById('growth-summary').innerHTML = `
    <div class="pnl-card">
      <div class="pnl-card-label">期間淨資產變化</div>
      <div class="pnl-card-value priv-amt ${pnlClass(nwChange)}">${nwChange >= 0 ? '+' : ''}${fmtFull(Math.abs(nwChange))}</div>
      <div class="pnl-card-sub priv-amt ${pnlClass(nwPct)}">${fmtPct(nwPct)} (${daysSpan} 筆資料)</div>
    </div>
    <div class="pnl-card">
      <div class="pnl-card-label">起始淨資產</div>
      <div class="pnl-card-value priv-amt">${fmtFull(first.net_worth)}</div>
      <div class="pnl-card-sub">${filtered[0]}</div>
    </div>
    <div class="pnl-card">
      <div class="pnl-card-label">目前淨資產</div>
      <div class="pnl-card-value priv-amt">${fmtFull(last.net_worth)}</div>
      <div class="pnl-card-sub">${filtered[filtered.length - 1]}</div>
    </div>
  `;

  // 簡化模式：歷史月資料大多無 asset_groups，只顯示兩條折線
  const _hasGroupCount = filtered.filter(d => state.history[d].asset_groups).length;
  const _simplified = _hasGroupCount < filtered.length * 0.5;

  // Render chart
  const ctx = document.getElementById('growth-chart').getContext('2d');
  if (charts.growth) charts.growth.destroy();

  const _labels = _simplified
    ? filtered.map(d => d.slice(0, 7))   // YYYY-MM for monthly view
    : filtered;

  charts.growth = new Chart(ctx, {
    type: _simplified ? 'line' : 'bar',
    data: {
      labels: _labels,
      datasets: _simplified ? [netWorthLine, liabLine] : [netWorthLine, liabLine, ...stackedDatasets],
    },
    plugins: [minMaxPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        minMaxLabels: {},
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
              if (state.privacy) return ` ${c.dataset.label}: ●●●`;
              if (c.dataset.yAxisID === 'y2') return ` ${c.dataset.label}: ${c.raw?.toFixed(2)}x`;
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
            callback: v => state.privacy ? '●●●' : v.toLocaleString() + ' 萬',
          },
          grid: { color: 'rgba(255,255,255,.05)' },
        },
        y2: {
          type: 'linear',
          position: 'right',
          ticks: {
            color: '#fb923c',
            callback: v => state.privacy ? '●' : v.toFixed(2) + 'x',
            maxTicksLimit: 6,
          },
          grid: { display: false },
          title: {
            display: true,
            text: '槓桿/曝險',
            color: '#fb923c',
            font: { size: 10 },
          },
        },
      }
    }
  });
}

// ══ Trend Chart ═════════════════════════════════════════════════════════
export async function renderTrendChart() {
  // Use daily snapshots from history.json (alm_history)
  if (Object.keys(state.history).length === 0) {
    await loadHistory();
  }

  const chartContainer = document.getElementById('trend-chart-container');
  const today = localISODate();

  const _showEmpty = (msg) => {
    if (chartContainer) chartContainer.innerHTML =
      `<div class="empty-state" style="padding:40px 0;text-align:center">${msg}</div>`;
  };
  const _ensureCanvas = () => {
    if (!document.getElementById('trend-chart')) {
      if (chartContainer) chartContainer.innerHTML = '<canvas id="trend-chart"></canvas>';
    }
  };

  const allDates = Object.keys(state.history).sort();
  if (allDates.length === 0) {
    _showEmpty('尚無歷史資料，點擊「💾 儲存資料」開始記錄');
    return;
  }

  const startEl = document.getElementById('growth-start');
  const endEl = document.getElementById('growth-end');
  if (!startEl.value) startEl.value = new Date().getFullYear() + '-01-01';
  if (!endEl.value)   endEl.value   = today;

  const start = startEl.value;
  const end   = endEl.value;

  const filtered = allDates.filter(d => d >= start && d <= end);
  if (filtered.length === 0) {
    _showEmpty('所選範圍內無資料');
    return;
  }

  _ensureCanvas();

  const labels = filtered;
  const first = state.history[filtered[0]];
  const firstAdj = adjSnap(first);

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
    const isNW = s.key === 'net_worth';
    const base = isNW ? firstAdj.net_worth : first[s.key];
    const data = filtered.map(d => {
      const v = isNW ? adjSnap(state.history[d]).net_worth : state.history[d][s.key];
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
      _minMaxFmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%',
    };
  });

  const ctx = document.getElementById('trend-chart').getContext('2d');
  if (charts.trend) charts.trend.destroy();

  charts.trend = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    plugins: [minMaxPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        minMaxLabels: {},
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
