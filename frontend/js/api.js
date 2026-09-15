// Backend fetch wrapper + all portfolio/history load & save calls.

import { calcTotals } from './dashboard.js';
import { currentPage, goPage } from './routing.js';
import { API, state } from './state.js';
import { localISODate, toast } from './utils.js';

// ══ API wrapper ═════════════════════════════════════════════════════════
export async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}


// ══ Data loading ════════════════════════════════════════════════════════
export async function loadPortfolio() {
  try {
    state.portfolio = await api('/api/portfolio');
  } catch (e) { console.error(e); }
}

export async function loadIndices() {
  try {
    state.indices = await api('/api/indices');
    if (state.indices.usd_twd) state.usdTwd = state.indices.usd_twd;
    if (state.indices.jpy_twd) state.jpyTwd = state.indices.jpy_twd;
  } catch (e) { console.error(e); }
}

export async function loadManualHistory() {
  try {
    state.manualHistory = await api('/api/manual-history');
  } catch (e) { console.error(e); }
}

export async function loadHistory() {
  try {
    state.history = await api('/api/history');
    updateLastSaveDisplay();
  } catch (e) { console.error(e); }
}

export function updateLastSaveDisplay() {
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

export async function refreshCbSuspensions() {
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

export async function refreshPrices() {
  const twStocks  = [];   // TW stock symbols (no suffix)
  const usTickers = [];   // US stock symbols
  const cbSymbols = [];   // CB symbols

  const _isTwSym = s => /^\d{4,6}[A-Z]?$/i.test(s.trim());
  for (const g of state.portfolio.investments) {
    const isCB = g.group === '可轉債';
    for (const item of g.items) {
      if (!item.symbol) continue;
      const sym = item.symbol.trim();
      if (isCB)             cbSymbols.push(sym);
      else if (_isTwSym(sym)) twStocks.push(sym);
      else                  usTickers.push(sym);
    }
  }

  const promises = [];

  // TW stocks → MIS API (handles both TSE 上市 and OTC 上櫃, returns change_pct)
  if (twStocks.length > 0) {
    const q = [...new Set(twStocks)].join(',');
    promises.push(
      api('/api/tw-prices?symbols=' + encodeURIComponent(q) + '&force=true')
        .then(data => {
          for (const g of state.portfolio.investments) {
            if (g.group === '可轉債') continue;
            for (const item of g.items) {
              if (!item.symbol) continue;
              if (!_isTwSym(item.symbol)) continue;
              const d = data[item.symbol.toUpperCase()];   // normalize: 00988a → 00988A
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
            if (g.group === '可轉債') continue;
            for (const item of g.items) {
              if (!item.symbol) continue;
              if (_isTwSym(item.symbol)) continue;
              const d = data[item.symbol.toUpperCase()];
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
              const d = data[item.symbol.toUpperCase()];
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


// ══ Save portfolio ══════════════════════════════════════════════════════
export async function savePortfolio() {
  try {
    await api('/api/portfolio', { method: 'POST', body: JSON.stringify(state.portfolio) });
  } catch (e) { console.error(e); toast('儲存失敗', 'error'); }
}

// ══ Snapshot ════════════════════════════════════════════════════════════
export async function saveSnapshot() {
  const t = calcTotals();
  const idx = state.indices;
  const body = {
    date: localISODate(),
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
    await goPage(currentPage());   // re-render whichever page is visible (lazy-loads it if needed)
    toast('✅ 資料已儲存');
  } catch (e) { toast('資料儲存失敗', 'error'); }
}

export async function pushHistoryToGist() {
  const btn = document.getElementById('btn-push-history');
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> 推送中...';
  btn.disabled = true;
  try {
    const res = await api('/api/history/push-gist', { method: 'POST' });
    if (!res.ok) throw new Error(res.msg || 'failed');
    toast('✅ history.json 已推到雲端');
  } catch (e) {
    toast('❌ 推送失敗: ' + (e?.message || e), 'error');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}

// ══ Refresh all ═════════════════════════════════════════════════════════
export async function syncFromGist(force = false) {
  const btn = document.getElementById('btn-sync-gist');
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> 同步中...';
  btn.disabled = true;
  try {
    const url = '/api/sync-from-gist' + (force ? '?force=true' : '');
    const res = await api(url);
    if (!res.ok) throw new Error(res.error || 'failed');

    const pulled      = res.files.filter(f => f.action === 'pulled').map(f => f.name);
    const localNewer  = res.files.filter(f => f.action === 'local_newer').map(f => f.name);
    const inSync      = res.files.filter(f => f.action === 'in_sync').map(f => f.name);

    if (pulled.length > 0) {
      // Reload data from the freshly-written local files
      await Promise.all([loadPortfolio(), loadManualHistory(), loadHistory()]);
      calcTotals();
      await goPage(currentPage());   // re-render whichever page is visible (lazy-loads it if needed)
    }

    let msg = `☁️ [${res.env}] `;
    if (pulled.length)     msg += `已更新: ${pulled.join(', ')}. `;
    if (localNewer.length) msg += `本地較新 (未覆蓋): ${localNewer.join(', ')}. `;
    if (inSync.length && !pulled.length && !localNewer.length) msg += '資料已是最新';

    // If local has newer data, offer force pull
    if (localNewer.length > 0 && !force) {
      msg += ' 如需強制用雲端覆蓋，請長按同步按鈕。';
    }
    toast(msg, pulled.length > 0 ? 'success' : 'info');
  } catch(e) {
    toast('☁️ 同步失敗: ' + e.message, 'error');
  } finally {
    btn.innerHTML = orig;
    btn.disabled = false;
  }
}

export let _refreshLock = false;

export async function refreshAll() {
  if (_refreshLock) return;
  _refreshLock = true;

  const icoEl = document.getElementById('refresh-ico');
  const txtEl = document.getElementById('refresh-txt');

  try {
    if (icoEl) icoEl.innerHTML = '<span class="spinner"></span>';
    if (txtEl) txtEl.textContent = '更新中...';

    state._cbSuspensionLoaded = false;
    const { _punishCache } = await import('./fsc.js');
    _punishCache.data = null;
    await Promise.all([
      loadIndices(),
      refreshPrices(),
      refreshCbSuspensions(),
    ]);
    calcTotals();
    savePortfolio();

    await goPage(currentPage());   // re-render whichever page is visible (lazy-loads it if needed)

    toast('✅ 已更新');
  } catch (e) {
    toast('❌ 更新失敗: ' + (e?.message || e), 'error');
  } finally {
    _refreshLock = false;
    if (icoEl) icoEl.textContent = '🔄';
    if (txtEl) txtEl.textContent = '更新數據';
  }
}
