// CB餘額對照 (CB bookentry vs stock price) chart.

import { api } from './api.js';
import { API, state } from './state.js';

// ── CB 餘額 vs 現股股價 ────────────────────────────────────────────────────────
export let _cbBEChart = null;
export let _cbBELastData = null;

export function _initCbBookentryMyCbs() {
  const el = document.getElementById('cb-be-my');
  if (!el) return;
  const cbGroup = state.portfolio?.investments?.find(g => g.group === '可轉債');
  const codes = [...new Set(
    (cbGroup?.items || []).map(i => String(i.symbol || '').trim()).filter(c => /^\d{5}$/.test(c))
  )];
  if (!codes.length) {
    el.innerHTML = '<span style="font-size:11px;color:var(--muted)">（我的CB：尚無可轉債部位）</span>';
    return;
  }
  el.innerHTML =
    '<span style="font-size:11px;color:var(--muted);margin-right:4px">我的CB：</span>' +
    codes.map(c => {
      const item = cbGroup.items.find(i => i.symbol === c);
      const label = item?.name ? `${c} ${item.name}` : c;
      return `<button onclick="document.getElementById('cb-be-input').value='${c}';renderCbBookentryChart()"
        style="padding:2px 9px;border-radius:12px;font-size:11px;cursor:pointer;
               background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.3);color:var(--primary)"
      >${label}</button>`;
    }).join('');
}

export async function renderCbBookentryChart(force = false, _useCache = false) {
  const code = (document.getElementById('cb-be-input')?.value || '').trim();
  if (!code) return;

  const msg  = document.getElementById('cb-be-msg');
  const wrap = document.getElementById('cb-be-chart-wrap');
  const stats= document.getElementById('cb-be-stats');
  const convEl = document.getElementById('cb-be-conv');

  let data;
  if (_useCache && _cbBELastData) {
    data = _cbBELastData;
    // _useCache = 使用者手動改轉換價重繪，不動 convEl
  } else {
    msg.style.display  = 'block';
    msg.textContent    = '⏳ 載入中…';
    if (wrap)  wrap.style.display  = 'none';
    if (stats) stats.style.display = 'none';
    try {
      data = await api(`/api/cb-bookentry?code=${encodeURIComponent(code)}${force ? '&force=true' : ''}`);
    } catch (e) {
      msg.style.display = 'block';
      msg.textContent = `載入失敗：${e.message}`;
      return;
    }
    if (!data.labels?.length) { msg.textContent = '查無資料，請確認 CB 代號'; return; }
    _cbBELastData = data;
    // 切換標的時從 API 更新轉換價；API 無值則清空
    if (convEl) convEl.value = data.convPrice != null ? data.convPrice : '';
  }

  try {
    // ── Stats bar ──────────────────────────────────────────────────────────
    const initBE  = data.bookentry[0]  || 0;
    const lastBE  = data.bookentry[data.bookentry.length - 1] || 0;
    const convPct = initBE > 0 ? ((initBE - lastBE) / initBE * 100).toFixed(1) : '—';
    const lastPx  = data.prices[data.prices.length - 1] ?? '—';
    const dateRng = `${data.labels[0]} ～ ${data.labels[data.labels.length - 1]}`;
    const convColor = parseFloat(convPct) >= 80 ? 'var(--green)' : parseFloat(convPct) >= 40 ? 'var(--orange)' : 'var(--text)';

    const statCard = (label, value, color = 'var(--text)', nowrap = false) => `
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;min-width:0;flex:0 1 auto">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;white-space:nowrap">${label}</div>
        <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:${color};${nowrap ? 'white-space:nowrap' : ''}">${value}</div>
      </div>`;

    const convPriceVal = parseFloat(convEl?.value) || null;

    if (stats) {
      stats.style.display = 'flex';
      stats.innerHTML =
        statCard('CB 代號', data.cbName ? `${data.code} ${data.cbName}` : data.code) +
        statCard('發行量', `${initBE.toLocaleString()} 張`) +
        statCard('剩餘量', `${lastBE.toLocaleString()} 張`) +
        statCard('累計轉換', `${convPct}%`, convColor) +
        statCard('現股最新', `${lastPx} 元`) +
        (convPriceVal ? statCard('轉換價格', `${convPriceVal} 元`, 'var(--green)') : '') +
        statCard('資料期間', dateRng, 'var(--text)', true);
    }

    // ── Chart ──────────────────────────────────────────────────────────────
    msg.style.display = 'none';
    if (wrap) wrap.style.display = 'block';

    if (_cbBEChart) { _cbBEChart.destroy(); _cbBEChart = null; }
    const ctx = document.getElementById('cb-be-canvas')?.getContext('2d');
    if (!ctx) return;

    // CB 餘額轉為百分比（以第一個數值為 100%）
    const beBase = data.bookentry[0] || 1;
    const bePct  = data.bookentry.map(v => v != null ? +(v / beBase * 100).toFixed(2) : null);

    const datasets = [
      {
        label: '📉 CB 餘額（%）',
        data: bePct,
        borderColor: 'rgba(14,165,233,1)',
        backgroundColor: 'rgba(14,165,233,.06)',
        borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 4,
        fill: true,
        yAxisID: 'yL',
        tension: 0.1,
      },
      {
        label: '📈 現股股價（元）',
        data: data.prices,
        borderColor: 'rgba(239,68,68,1)',
        backgroundColor: 'rgba(239,68,68,0)',
        borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 4,
        fill: false,
        yAxisID: 'yR',
        tension: 0.1,
      },
    ];

    if (convPriceVal) {
      datasets.push({
        label: `💚 轉換價 ${convPriceVal} 元`,
        data: Array(data.labels.length).fill(convPriceVal),
        yAxisID: 'yR',
        borderColor: 'rgba(34,197,94,.8)',
        pointBackgroundColor: 'rgba(34,197,94,0)',
        pointBorderColor: 'rgba(34,197,94,0)',
        borderDash: [4, 4],
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        tension: 0,
      });
      const convPrice130 = +(convPriceVal * 1.3).toFixed(2);
      datasets.push({
        label: `🟡 神秘價 ${convPrice130} 元`,
        data: Array(data.labels.length).fill(convPrice130),
        yAxisID: 'yR',
        borderColor: 'rgba(234,179,8,.85)',
        pointBackgroundColor: 'rgba(234,179,8,0)',
        pointBorderColor: 'rgba(234,179,8,0)',
        borderDash: [6, 3],
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        tension: 0,
      });
    }

    _cbBEChart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { font: { size: 11, weight: '600' }, boxWidth: 12, padding: 16 } },
          tooltip: {
            padding: 10,
            backgroundColor: 'rgba(15,23,42,.92)',
            titleFont: { size: 12, weight: '700' },
            bodyFont: { size: 11 },
            callbacks: {
              label: c => {
                if (c.datasetIndex === 0) return ` 餘額: ${c.raw?.toFixed(1)}%（${Math.round((c.raw ?? 0) / 100 * beBase).toLocaleString()} 張）`;
                if (c.datasetIndex === 2) return ` 轉換價: ${c.raw} 元`;
                if (c.datasetIndex === 3) return ` 神秘價: ${c.raw} 元`;
                return ` 股價: ${c.raw} 元`;
              },
            },
          },
        },
        scales: {
          yL: {
            type: 'linear', position: 'left',
            min: 0, max: 100,
            title: { display: true, text: 'CB 餘額（%）', color: 'rgba(14,165,233,.9)', font: { size: 10 } },
            grid: { color: 'rgba(148,163,184,.08)' },
            ticks: { color: 'rgba(14,165,233,.8)', font: { size: 10 }, callback: v => v + '%' },
          },
          yR: {
            type: 'linear', position: 'right',
            title: { display: true, text: '現股股價（元）', color: 'rgba(239,68,68,.9)', font: { size: 10 } },
            grid: { drawOnChartArea: false },
            ticks: { color: 'rgba(239,68,68,.8)', font: { size: 10 } },
          },
          x: {
            grid: { display: false },
            ticks: { maxTicksLimit: 10, font: { size: 10 }, color: 'rgba(148,163,184,.5)' },
          },
        },
      },
    });

    if (data.stale) {
      msg.style.display = 'block';
      msg.innerHTML = '<span style="color:var(--orange);font-size:11px">⚠️ 使用快取資料（今日抓取失敗）</span>';
    }

  } catch (e) {
    msg.style.display = 'block';
    msg.textContent = `載入失敗：${e.message}`;
    if (wrap)  wrap.style.display  = 'none';
    if (stats) stats.style.display = 'none';
  }
}

// 轉換價輸入框變更時：用快取資料重繪，不重新 fetch，不覆蓋輸入框
export function _cbBeRedrawConv() {
  if (_cbBELastData) renderCbBookentryChart(false, true);
}
