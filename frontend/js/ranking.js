// 成交值排行 page.

import { api } from './api.js';
import { state } from './state.js';

// ── 成交值排行 ────────────────────────────────────────────────────────────────
export let _rankingCache = { data: null, ts: 0 };
export const _staleBadge = ' <span title="非當日，雲端中繼的最後良好值" style="background:rgba(245,158,11,.2);color:#f59e0b;font-size:10px;font-weight:700;padding:0 4px;border-radius:3px;vertical-align:middle">舊</span>';

export async function renderRanking(force = false) {
  const body = document.getElementById('ranking-body');
  if (!body) return;

  const AGE = 30 * 60 * 1000;
  if (!force && _rankingCache.data && Date.now() - _rankingCache.ts < AGE) {
    _renderRankingData(_rankingCache.data);
    return;
  }

  body.innerHTML = `<div class="empty-state" style="padding:40px 0">⏳ 正在抓取成交值資料…</div>`;

  try {
    const res = await fetch('/api/turnover-ranking');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    _rankingCache = { data, ts: Date.now() };
    _renderRankingData(data);
  } catch (e) {
    body.innerHTML = `<div class="empty-state" style="color:var(--red)">載入失敗：${e.message}</div>`;
  }
}

export function _rankRow(item, rank) {
  // Rank label
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null;
  const rankEl = medal
    ? `<span style="font-size:14px">${medal}</span>`
    : `<span style="font-size:11px;font-weight:700;color:var(--text-muted)">${rank}</span>`;

  // Streak badge
  let streakEl = '';
  if (item.streak >= 2) {
    const fc = item.streak >= 20 ? '#f97316' : item.streak >= 10 ? '#fbbf24' : '#94a3b8';
    streakEl = `<span style="color:${fc};font-size:10px;margin-left:3px">🔥${item.streak}d</span>`;
  } else if (item.rank_delta == null) {
    streakEl = `<span style="color:#6366f1;font-size:9px;font-weight:700;margin-left:3px;
      background:rgba(99,102,241,.15);padding:1px 3px;border-radius:3px">NEW</span>`;
  }

  // Rank delta
  let deltaEl = '<span style="color:var(--text-muted);font-size:10px">─</span>';
  if (item.rank_delta == null) {
    deltaEl = '';
  } else if (item.rank_delta > 0) {
    deltaEl = `<span style="color:#f43f5e;font-size:10px;font-weight:700">▲${item.rank_delta}</span>`;
  } else if (item.rank_delta < 0) {
    deltaEl = `<span style="color:#10b981;font-size:10px;font-weight:700">▼${Math.abs(item.rank_delta)}</span>`;
  }

  // Price + change
  const closeStr = item.close != null ? item.close.toFixed(2) : '—';
  let chgEl = '<span style="color:var(--text-muted)">—</span>';
  if (item.chg_pct != null) {
    const col  = item.chg_pct > 0 ? 'var(--red)' : item.chg_pct < 0 ? 'var(--green)' : 'var(--text-muted)';
    const sign = item.chg_pct > 0 ? '+' : '';
    chgEl = `<span style="color:${col}">${sign}${item.chg_pct.toFixed(2)}%</span>`;
  }

  const bil = (item.turnover / 1e8).toFixed(1);
  const pct = Math.min(100, item._barPct || 100);
  const barCol = rank <= 3 ? 'rgba(251,191,36,.25)' : 'rgba(99,102,241,.12)';

  return `<div style="
      position:relative;overflow:hidden;
      display:grid;grid-template-columns:22px 1fr 38px 50px 86px 24px;
      align-items:center;gap:4px;
      padding:4px 8px;border-radius:6px;
      background:var(--surface-1);border:1px solid var(--border);
    ">
    <div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${barCol};pointer-events:none;z-index:0;border-radius:6px 0 0 6px"></div>
    <div style="position:relative;z-index:1;text-align:center">${rankEl}</div>
    <div style="position:relative;z-index:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted)">${item.code}</span>
      <span style="font-weight:600;margin-left:3px">${item.name}</span>${streakEl}
    </div>
    <div style="position:relative;z-index:1;text-align:center;font-size:10px">${deltaEl}</div>
    <div style="position:relative;z-index:1;text-align:right;font-size:12px;font-weight:600">${bil}億</div>
    <div style="position:relative;z-index:1;text-align:right;font-size:11px;font-family:'JetBrains Mono',monospace">
      ${closeStr}<br><span style="font-size:10px">${chgEl}</span>
    </div>
    <div style="position:relative;z-index:1;text-align:center"></div>
  </div>`;
}

export function _renderRankingData(data) {
  const body  = document.getElementById('ranking-body');
  const subEl = document.getElementById('ranking-sub');
  if (!body) return;

  const td = data.trade_date || '—';
  const ts = data.ts ? new Date(data.ts * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '—';
  if (subEl) subEl.textContent = `資料日期 ${td}　${ts}`;

  function colHeader() {
    return `<div style="display:grid;grid-template-columns:22px 1fr 38px 50px 86px 24px;gap:4px;
                padding:3px 8px 5px;font-size:10px;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);margin-bottom:4px">
      <div style="text-align:center">#</div>
      <div>名稱</div>
      <div style="text-align:center">漲跌</div>
      <div style="text-align:right">成交值</div>
      <div style="text-align:right">收盤 / 漲跌%</div>
      <div></div>
    </div>`;
  }

  function buildList(items) {
    if (!items || !items.length)
      return `<div style="color:var(--text-muted);padding:12px;text-align:center;font-size:12px">無資料</div>`;
    const max = items[0].turnover || 1;
    return colHeader() + items.map((item, i) => {
      item._barPct = (item.turnover / max) * 100;
      return _rankRow(item, i + 1);
    }).join('');
  }

  const hdr = (ico, label) => `<div style="font-size:11px;font-weight:700;color:var(--text-muted);
    padding:0 4px 6px;border-bottom:2px solid var(--border);margin-bottom:6px">${ico} ${label}</div>`;

  function buildChanges(changes, label) {
    if (!changes) return '';
    const { added = [], removed = [] } = changes;
    // No membership change today — show an explicit note so the column doesn't
    // look like it's missing (e.g. OTC top-25 unchanged between trading days).
    if (!added.length && !removed.length)
      return `<div>
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);padding:0 4px 6px;border-bottom:2px solid var(--border);margin-bottom:8px">${label}</div>
        <div style="font-size:12px;color:var(--text-muted);padding:2px 4px">本日無進出（前 25 名不變）</div>
      </div>`;

    const pill = (text, bg, border, extra = '') =>
      `<span style="display:inline-flex;align-items:center;gap:3px;
        padding:2px 7px;border-radius:12px;font-size:11px;font-weight:600;
        background:${bg};border:1px solid ${border};white-space:nowrap;${extra}">${text}</span>`;

    const addedPills = added.map(x =>
      pill(`<span style="opacity:.7">${x.code}</span> ${x.name} <span style="opacity:.6">#${x.rank}</span>`,
           'rgba(244,63,94,.10)', 'rgba(244,63,94,.35)')
    ).join(' ');

    const removedPills = removed.map(x =>
      pill(`<span style="opacity:.7">${x.code}</span> ${x.name} <span style="opacity:.6">#${x.prev_rank}</span>`,
           'rgba(16,185,129,.12)', 'rgba(16,185,129,.4)', 'text-decoration:line-through;')
    ).join(' ');

    const rows = [];
    if (added.length)   rows.push(`<div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;font-weight:700;color:#f43f5e;flex-shrink:0;padding-top:2px">▲ 新增 ${added.length}</span>${addedPills}</div>`);
    if (removed.length) rows.push(`<div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;font-weight:700;color:#10b981;flex-shrink:0;padding-top:2px">▼ 移除 ${removed.length}</span>${removedPills}</div>`);

    return `<div>
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);padding:0 4px 6px;border-bottom:2px solid var(--border);margin-bottom:8px">${label}</div>
      <div style="display:flex;flex-direction:column;gap:6px">${rows.join('')}</div>
    </div>`;
  }

  const twseChanges = buildChanges(data.twse_changes, '🏛️ 上市異動');
  const tpexChanges = buildChanges(data.tpex_changes, '🏪 上櫃異動');
  const changesHtml = (twseChanges || tpexChanges) ? `
    <div style="margin-bottom:14px;padding:10px 14px;border-radius:10px;
      background:var(--surface-1);border:1px solid var(--border)">
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:10px;
        letter-spacing:.04em">📋 異動紀錄　<span style="font-weight:400">vs 前一交易日</span></div>
      <div class="ranking-2col">
        ${twseChanges || '<div></div>'}${tpexChanges || '<div></div>'}
      </div>
    </div>` : '';

  body.innerHTML = `
    ${changesHtml}
    <div class="ranking-2col">
      <div>${hdr('🏛️', '上市 TWSE' + (data.twse_stale ? _staleBadge : ''))}${buildList(data.twse)}</div>
      <div>${hdr('🏪', '上櫃 TPEX' + (data.tpex_stale ? _staleBadge : ''))}${buildList(data.tpex)}</div>
    </div>`;
}
