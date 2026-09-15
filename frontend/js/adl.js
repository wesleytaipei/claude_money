// A/D Line (騰落線) chart.

import { api } from './api.js';

// ── A/D Line chart ───────────────────────────────────────────────────────────
export let _adlChart = null;
export let _adlCache = { data: null, ts: 0 };

export async function renderAdlChart(force = false) {
  const canvas = document.getElementById('adl-chart');
  const statsEl = document.getElementById('adl-stats');
  if (!canvas || !statsEl) return;

  const TTL = 30 * 60 * 1000; // 30 min
  if (!force && _adlCache.data && Date.now() - _adlCache.ts < TTL) {
    _drawAdlChart(_adlCache.data);
    return;
  }

  statsEl.innerHTML = '<span style="color:var(--muted);font-size:13px">⏳ 載入中…</span>';

  try {
    const res = await fetch('/api/advance-decline');
    const json = await res.json();
    const rows = json.data || [];

    if (!rows.length) {
      statsEl.innerHTML = '<span style="color:var(--muted);font-size:13px">⏳ 首次建立資料庫中，約需 30 秒，請稍後重新整理…</span>';
      return;
    }

    _adlCache = { data: rows, ts: Date.now() };
    _drawAdlChart(rows);
  } catch(e) {
    statsEl.innerHTML = '<span style="color:var(--red);font-size:13px">⚠ 無法載入騰落線資料</span>';
  }
}

export function _drawAdlChart(rows) {
  const statsEl = document.getElementById('adl-stats');
  const canvas  = document.getElementById('adl-chart');
  if (!statsEl || !canvas) return;

  // ── Stats cards ──────────────────────────────────────────
  const last = rows[rows.length - 1];
  const net  = last.raise - last.fall;
  const total = last.raise + last.fall;
  const raiseRate = total > 0 ? (last.raise / total * 100).toFixed(1) : '—';

  // 3-day and 5-day average raise rate
  function avgRate(n) {
    const slice = rows.slice(-n);
    if (!slice.length) return '—';
    const avg = slice.reduce((s, r) => {
      const t = r.raise + r.fall;
      return s + (t > 0 ? r.raise / t * 100 : 50);
    }, 0) / slice.length;
    return avg.toFixed(2);
  }

  const netColor = net >= 0 ? 'var(--red)' : 'var(--green)';
  const rateColor = r => +r >= 55 ? 'var(--red)' : +r <= 45 ? 'var(--green)' : 'var(--text-dim)';

  statsEl.innerHTML = `
    <div style="background:var(--surface-2);border-radius:10px;padding:10px 16px;min-width:100px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">淨上漲家數</div>
      <div style="font-size:20px;font-weight:700;color:${netColor}">${net >= 0 ? '+' : ''}${net}</div>
    </div>
    <div style="background:var(--surface-2);border-radius:10px;padding:10px 16px;min-width:100px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">上市+上櫃 上漲/下跌</div>
      <div style="font-size:15px;font-weight:600">
        <span style="color:var(--red)">${last.raise.toLocaleString()}</span>
        <span style="color:var(--muted)"> / </span>
        <span style="color:var(--green)">${last.fall.toLocaleString()}</span>
      </div>
    </div>
    <div style="background:var(--surface-2);border-radius:10px;padding:10px 16px;min-width:100px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">今日上漲率</div>
      <div style="font-size:20px;font-weight:700;color:${rateColor(raiseRate)}">${raiseRate}%</div>
    </div>
    <div style="background:var(--surface-2);border-radius:10px;padding:10px 16px;min-width:100px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">3日平均</div>
      <div style="font-size:20px;font-weight:700;color:${rateColor(avgRate(3))}">${avgRate(3)}%</div>
    </div>
    <div style="background:var(--surface-2);border-radius:10px;padding:10px 16px;min-width:100px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">5日平均</div>
      <div style="font-size:20px;font-weight:700;color:${rateColor(avgRate(5))}">${avgRate(5)}%</div>
    </div>
    <div style="font-size:12px;color:var(--muted);align-self:flex-end;padding-bottom:8px">
      ${last.date.slice(0,4)}/${last.date.slice(4,6)}/${last.date.slice(6,8)}
    </div>
  `;

  // ── Chart ────────────────────────────────────────────────
  const labels    = rows.map(r => `${r.date.slice(4,6)}/${r.date.slice(6,8)}`);
  const adlVals   = rows.map(r => r.adl);
  const taiexVals = rows.map(r => r.taiex ?? null);
  const otcVals   = rows.map(r => r.otc  ?? null);

  if (_adlChart) _adlChart.destroy();
  _adlChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '騰落線',
          data: adlVals,
          yAxisID: 'y',
          borderColor: 'rgba(244,63,94,.85)',
          backgroundColor: 'rgba(244,63,94,.05)',
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          tension: 0.3,
          order: 3,
          segment: {
            borderColor: ctx => {
              const i = ctx.p1DataIndex;
              if (i === 0) return 'rgba(244,63,94,.85)';
              // 台股慣例：紅 = 線上升（廣度擴張）、綠 = 線下降（廣度收縮）
              return adlVals[i] >= adlVals[i-1]
                ? 'rgba(244,63,94,.85)'
                : 'rgba(16,185,129,.85)';
            },
            backgroundColor: ctx => {
              const i = ctx.p1DataIndex;
              return adlVals[i] >= adlVals[i-1]
                ? 'rgba(244,63,94,.04)'
                : 'rgba(16,185,129,.04)';
            },
          },
        },
        {
          label: '加權指數',
          data: taiexVals,
          yAxisID: 'y2',
          borderColor: 'rgba(249,115,22,.9)',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          order: 1,
          spanGaps: true,
        },
        {
          label: '櫃買指數',
          data: otcVals,
          yAxisID: 'y3',
          borderColor: 'rgba(20,184,166,.9)',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          order: 2,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#646f92', boxWidth: 14, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === '騰落線') {
                const r = rows[ctx.dataIndex];
                return [
                  `騰落線: ${ctx.parsed.y.toLocaleString()}`,
                  `上漲 ${r.raise} / 下跌 ${r.fall}  淨 ${r.raise-r.fall >= 0?'+':''}${r.raise-r.fall}`,
                ];
              }
              const v = ctx.parsed.y;
              return v != null ? `${ctx.dataset.label}: ${v.toLocaleString()}` : null;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(34,48,90,.5)' },
          ticks: { color: '#646f92', maxTicksLimit: 12, maxRotation: 0 },
        },
        y: {
          type: 'linear', position: 'left',
          grid: { color: 'rgba(34,48,90,.5)' },
          ticks: { color: '#646f92', callback: v => v.toLocaleString() },
        },
        y2: {
          type: 'linear', position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: 'rgba(249,115,22,.8)', callback: v => v.toLocaleString() },
        },
        y3: {
          type: 'linear', position: 'right',
          display: false,
        },
      },
    },
  });
}
