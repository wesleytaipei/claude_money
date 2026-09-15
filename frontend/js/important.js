// 重要資訊 (market indicators) page + 大戶籌碼 cell helper.

import { api } from './api.js';
import { renderCbListed } from './cb-listed.js';
import { renderFscOfferings } from './fsc.js';
import { state } from './state.js';
import { fmt } from './utils.js';


// ══ Important Info ═════════════════════════════════════════════════════
export function _importantMetricFailed(metric) {
  if (!metric) return true;
  // price-style metric {price, change, change_pct}
  if ('price' in metric) return metric.price === '-' || metric.price == null;
  // current-style metric {current, prev}
  if ('current' in metric) return metric.current === null || metric.current === undefined;
  // balance-style metric {balance, increase}
  if ('balance' in metric) return metric.balance === null || metric.balance === undefined;
  return true;
}

export function _importantChangeColor(val) {
  if (val == null) return '';
  const s = String(val);
  const num = parseFloat(s.replace(/[+%,]/g, ''));
  if (isNaN(num)) return '';
  if (num > 0) return 'var(--red)';
  if (num < 0) return 'var(--green)';
  return '';
}

export const _importantCache = { ts: 0, data: null };
export const IMPORTANT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ── Chip data (大戶籌碼) cache — persists across page re-renders ────────────
export const _chipCache = {};  // { symbol: {total,current,prev,change,change_pct,...} | null | {error} }

export function _cbToParentSym(code) {
  // CB codes: 4-digit parent + 1-2 digit series  e.g. 15601→1560, 23161→2316
  const s = String(code || '').trim();
  return s.length >= 5 ? s.slice(0, 4) : s;
}

export function _chipCellHtml(data) {
  if (data === null) return '<span class="muted" style="font-size:11px">⋯</span>';
  if (!data || data.error) return '<span class="muted" style="font-size:11px">—</span>';

  const pct = data.change_pct ?? 0;
  const isFlat = Math.abs(pct) < 0.05;

  // Build tooltip (共用)
  const sign1 = (data.change || 0) >= 0 ? '+' : '';
  let tip = `集保總張數: ${(data.total||0).toLocaleString()}`
    + `&#10;大戶本週: ${(data.current||0).toLocaleString()}張 (${data.current_date ?? '—'})`
    + `&#10;大戶前週: ${(data.prev||0).toLocaleString()}張 (${data.prev_date ?? '—'})`
    + `&#10;週變化: ${sign1}${(data.change||0).toLocaleString()}張 (${pct >= 0 ? '+' : ''}${pct}%)`;
  if ((data.run_weeks || 1) >= 3) {
    const signR = (data.run_change || 0) >= 0 ? '+' : '';
    tip += `&#10;連${data.run_weeks}週累計: ${signR}${(data.run_change||0).toLocaleString()}張`
         + ` (${data.run_start_date ?? '—'}~${data.current_date ?? '—'})`;
  }

  if (isFlat) {
    return `<span class="muted" style="font-size:11px" title="${tip}">持平</span>`;
  }

  const runPct = data.run_change_pct ?? pct;
  const isDown = runPct < 0;
  const color  = isDown ? 'var(--green)' : 'var(--red)';
  const sign   = isDown ? '' : '+';

  return `<span style="color:${color};font-size:11px;white-space:nowrap" title="${tip}">${sign}${runPct.toFixed(2)}%</span>`;
}


// Estimate next trading day's TAIEX (加權指數) opening level from overnight markets.
// 方法一 台指期夜盤逆推 (primary, most accurate): 加權開盤 ≈ 台指期夜盤 − 基差，
//   基差 = 台指期日盤結算 − 加權現貨；台指期日盤結算由夜盤價與其漲跌%反推。
// 方法三 權重修正 (range): 用富台指漲跌% + 台積電ADR%，校正台積電在兩指數的權重差。
export function _estimateTaiexOpen(data) {
  const taiex = state.indices?.taiex?.price;
  if (!taiex) return null;
  const num = s => parseFloat(String(s ?? '').replace(/[,%+\s]/g, ''));
  const ests = [];
  // 方法一：台指期(WTX)夜盤逆推
  const wtxP = num(data.wtx?.price), wtxPct = num(data.wtx?.change_pct);
  if (isFinite(wtxP) && isFinite(wtxPct) && wtxPct > -100) {
    const txDaySettle = wtxP / (1 + wtxPct / 100);   // 台指期日盤結算
    const basis = txDaySettle - taiex;               // 期現基差
    ests.push({ name: '台指期夜盤逆推', val: wtxP - basis });
  }
  // 方法三：富台指 + 台積電ADR 權重修正
  const fpct = num(data.twncon?.change_pct), cpct = num(data.tsm_adr?.change_pct);
  if (isFinite(fpct)) {
    const wt = 0.35, wf = 0.20;                      // 台積電權重：加權35% / 富台指20%
    const dT = isFinite(cpct)
      ? fpct * (1 - wt) / (1 - wf) + cpct * (wt - wf) / (1 - wf)
      : fpct;
    ests.push({ name: '權重修正', val: taiex * (1 + dT / 100) });
  }
  if (!ests.length) return null;
  const vals = ests.map(e => e.val);
  const primary = ests[0].val;                       // 方法一優先
  return { primary, low: Math.min(...vals), high: Math.max(...vals),
           pct: (primary - taiex) / taiex * 100, taiex, methods: ests };
}

export async function renderImportantInfo(force = false) {
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
    const _ft = new Date(_importantCache.ts);
    const fetchTime = `${String(_ft.getMonth()+1).padStart(2,'0')}/${String(_ft.getDate()).padStart(2,'0')} ${String(_ft.getHours()).padStart(2,'0')}:${String(_ft.getMinutes()).padStart(2,'0')}`;

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
        changeKey: 'change',
        estTaiex: true },

      { name: '😱 台指VIX (TAIWANVIX)', src: 'TAIFEX',
        metric: data.vixtwn,
        fmt: o => o.price,
        sub: o => `${o.change} (${o.change_pct})`,
        // VIX 上升=恐慌升溫，本來就該紅色；紅漲綠跌下已與預設 changeKey 邏輯一致，不用再反轉
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

      { name: '🇹🇼 上市融資維持率', src: 'TWSE',
        metric: data.taiex_margin_ratio,
        fmt: o => `${o.current}%`,
        sub: o => {
          const chg = o.prev != null ? Math.round((o.current - o.prev) * 100) / 100 : null;
          const sign = chg != null ? (chg >= 0 ? '+' : '') : '';
          return o.prev != null ? `${o.prev}% (${sign}${chg}%)` : '—';
        },
        colorFn: o => o.current - o.prev },

      { name: '🇹🇼 上櫃融資維持率', src: 'TPEX',
        metric: data.tpex_margin_ratio,
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
      const staleBadge = r.metric && r.metric.stale
        ? ` <span title="非當日，雲端中繼的最後良好值" style="background:rgba(245,158,11,.2);color:#f59e0b;font-size:10px;font-weight:700;padding:0 4px;border-radius:3px;vertical-align:middle">舊</span>`
        : '';

      html += `<tr>
        <td style="font-weight:600">${r.name}</td>
        <td style="font-size:15px; font-weight:600; font-family:'JetBrains Mono',monospace">${v1}${staleBadge}</td>
        <td style="color:${subColor}; font-weight:500; font-family:'JetBrains Mono',monospace">${v2}</td>
      </tr>`;

      // 富台指下方：推估隔一交易日加權指數開盤
      if (r.estTaiex) {
        const e = _estimateTaiexOpen(data);
        if (e) {
          const col  = e.pct > 0 ? 'var(--red)' : e.pct < 0 ? 'var(--green)' : 'var(--text)';
          const sign = e.pct >= 0 ? '+' : '';
          const fmt0 = n => Math.round(n).toLocaleString('en-US');
          const range = Math.abs(e.high - e.low) > 1
            ? `<span style="color:var(--text-muted);font-weight:400;font-size:12px">　區間 ${fmt0(e.low)}~${fmt0(e.high)}</span>` : '';
          const tip = e.methods.map(m => `${m.name}：${fmt0(m.val)}`).join('&#10;');
          html += `<tr title="推估隔一交易日加權指數(現貨)開盤位置&#10;基準加權收盤 ${fmt0(e.taiex)}&#10;${tip}">
            <td style="padding-left:20px;color:var(--text-dim)">↳ 推估加權開盤 <span style="font-size:11px;color:var(--text-muted)">(隔日)</span></td>
            <td style="font-size:15px;font-weight:700;font-family:'JetBrains Mono',monospace;color:${col}">${fmt0(e.primary)}</td>
            <td style="color:${col};font-weight:600;font-family:'JetBrains Mono',monospace">${sign}${e.pct.toFixed(2)}%${range}</td>
          </tr>`;
        }
      }
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
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--danger)">❌ 資料載入失敗</td></tr>';
  }
  // Also render sub-panels (fire-and-forget, each has its own cache)
  renderCbListed(force);
  renderFscOfferings(force);
}
