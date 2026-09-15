// App shell: router, modal, settings, privacy, restore, init.
// Page-specific feature modules are NOT statically imported here — each is
// dynamically import()-ed the first time its page is navigated to (see
// PAGE_MODULES / _ensurePageModule below), so the initial bundle only pays
// for state/utils/charts/api/dashboard/routing. Once loaded, a page module's
// exports are copied onto `window` (same as main.js does for the eager
// modules), so the bare render-function calls below resolve at runtime
// exactly like the existing inline onclick="fn()" HTML handlers already do.

import { api, loadHistory, loadIndices, loadManualHistory, loadPortfolio, refreshPrices } from './api.js';
import { calcTotals, renderDashboard } from './dashboard.js';
import { charts, groupKey, itemKey, saveExcluded, state } from './state.js';
import { escapeAttr, fmtFull, localISODate, toast } from './utils.js';

// ── Lazy page modules ────────────────────────────────────────────────────
const PAGE_MODULES = {
  assets:        ['./assets.js'],
  investments:   ['./investments.js', './holdings-health.js'],
  growth:        ['./growth.js'],
  history:       ['./history.js'],
  'data-editor': ['./history.js'],
  important:     ['./important.js', './adl.js'],
  etf:           ['./etf.js'],
  ranking:       ['./ranking.js'],
  'cb-be':       ['./cb-be.js'],
  industry:      ['./industry.js'],
  'stock-zones': ['./stock-zones.js'],
  'market-heatmap': ['./market-heatmap.js'],
  'global-heatmap': ['./global-heatmap.js'],
};

async function _ensurePageModule(name) {
  const specs = PAGE_MODULES[name];
  if (!specs) return;   // dashboard needs nothing extra — already eager
  const mods = await Promise.all(specs.map(spec => import(spec)));
  for (const mod of mods) Object.assign(window, mod);
}

// ══ Privacy ═════════════════════════════════════════════════════════════
export function togglePrivacy() {
  state.privacy = !state.privacy;
  document.body.classList.toggle('privacy', state.privacy);
  document.getElementById('privacy-ico').textContent = state.privacy ? '🔒' : '👁';
  document.getElementById('privacy-txt').textContent = state.privacy ? '隱藏中' : '顯示中';
  const mobileIco = document.getElementById('mobile-privacy-ico');
  if (mobileIco) mobileIco.textContent = state.privacy ? '🙈' : '👁';
  charts.growth?.update();
  charts.trend?.update();
  charts.dashboardTrend?.update();
}

export function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isOpen = sidebar.classList.toggle('mobile-open');
  backdrop.classList.toggle('visible', isOpen);
}

// ══ Router ══════════════════════════════════════════════════════════════
export function currentPage() {
  const active = document.querySelector('.page.active');
  return active?.id.replace('page-', '') || 'dashboard';
}

export async function goPage(name) {
  // Close any open modal first to avoid stray dark overlay
  document.getElementById('modal-overlay').classList.add('hidden');

  // Fetch this page's module (if not already loaded) before rendering it
  await _ensurePageModule(name);

  // Render content BEFORE toggling active so the page is populated during fade-in
  calcTotals();
  if (name === 'dashboard') renderDashboard();
  else if (name === 'assets') renderAssetsPage();
  else if (name === 'investments') renderInvestmentsPage();
  else if (name === 'growth') { renderGrowthChart(); renderTrendChart(); }
  else if (name === 'history') renderHistoryPage();
  else if (name === 'important') { renderImportantInfo(false); renderAdlChart(false); }
  else if (name === 'etf') renderEtfPage(false);
  else if (name === 'ranking') renderRanking(false);
  else if (name === 'cb-be') _initCbBookentryMyCbs();
  else if (name === 'industry') renderIndustryMap(false);
  else if (name === 'data-editor') renderDataEditorPage();
  else if (name === 'stock-zones') renderStockZonesPage(false);
  else if (name === 'market-heatmap') renderMarketHeatmap(false);
  else if (name === 'global-heatmap') renderGlobalHeatmap(false);

  // industry.js / global-heatmap.js / market-heatmap.js may not be loaded yet if the
  // user has never visited that page
  if (window._stopIndustryAutoRefresh) window._stopIndustryAutoRefresh();
  if (name === 'industry') _startIndustryAutoRefresh();
  if (window._stopGlobalHeatAutoRefresh) window._stopGlobalHeatAutoRefresh();
  if (name === 'global-heatmap') _startGlobalHeatAutoRefresh();
  if (window._stopMarketHeatAutoRefresh) window._stopMarketHeatAutoRefresh();
  if (name === 'market-heatmap') _startMarketHeatAutoRefresh();

  // Switch active classes after content is ready
  document.querySelectorAll('.nav-item').forEach(n => {
    const isActive = n.dataset.page === name;
    n.classList.toggle('active', isActive);
    if (isActive && n.closest('#top-nav-menu')) {
      n.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));

  // Update mobile title and close sidebar
  const titles = {
    dashboard: '資產總覽', assets: '資產與負債', investments: '投資部位',
    growth: '資產成長圖', history: '歷史紀錄', important: '重要資訊',
    etf: 'ETF追蹤',
    ranking: '成交值排行',
    'cb-be': 'CB餘額對照',
    industry: '產業地圖',
    'data-editor': '資料管理',
    'stock-zones': '季線選股',
    'market-heatmap': '全市場熱力',
    'global-heatmap': '全球熱力',
  };
  const titleEl = document.getElementById('mobile-page-title');
  if (titleEl) titleEl.textContent = titles[name] || name;
  // Close sidebar on mobile after navigation
  document.querySelector('.sidebar').classList.remove('mobile-open');
  const bd = document.getElementById('sidebar-backdrop');
  if (bd) bd.classList.remove('visible');
}

export function scrollTopNav(delta) {
  const menu = document.getElementById('top-nav-menu');
  if (menu) menu.scrollBy({ left: delta, behavior: 'smooth' });
}


// ══ Settings Modal ═════════════════════════════════════════════════════
export function openSettingsModal() {
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

export function toggleGroup(section, gi, checked) {
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

export function toggleItem(section, gi, ii, checked) {
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
export function openModal(title, html) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

export function closeModal(event) {
  if (!event || event.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
}

// ══ Restore Modal ═══════════════════════════════════════════════════════
export async function openRestoreModal() {
  document.getElementById('modal-title').textContent = '⏪ 資料回溯';
  document.getElementById('modal-body').innerHTML = '<div style="padding:20px;color:var(--text-2)">載入備份清單…</div>';
  document.getElementById('modal-overlay').classList.remove('hidden');

  let data;
  try {
    data = await api('/api/backups');
  } catch (e) {
    document.getElementById('modal-body').innerHTML = `<div style="padding:20px;color:var(--red-2)">無法取得備份清單：${e.message}</div>`;
    return;
  }

  if (!data.dates || data.dates.length === 0) {
    document.getElementById('modal-body').innerHTML = `
      <div style="padding:20px;color:var(--text-2);text-align:center">
        尚無本地備份。點擊「儲存資料」後會自動建立每日備份。
      </div>`;
    return;
  }

  const rows = data.dates.map(b => {
    const filesInfo = b.files.map(f => {
      const kb = (f.size / 1024).toFixed(1);
      return `<span style="color:var(--text-2);font-size:11px">${f.name} (${kb} KB)</span>`;
    }).join(' &nbsp;·&nbsp; ');
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <div>
          <div style="font-weight:600;color:var(--text-1)">${b.date}</div>
          <div style="margin-top:3px">${filesInfo}</div>
        </div>
        <button class="btn-action" style="padding:6px 14px;font-size:12px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3)"
          onclick="restoreBackup('${b.date}')">回復此版本</button>
      </div>`;
  }).join('');

  document.getElementById('modal-body').innerHTML = `
    <div style="padding:4px 0 12px;color:var(--amber);font-size:12px">
      ⚠️ 回復前會先備份目前狀態，可再次回復到今天的版本來撤銷操作。回復後頁面將重新載入。
    </div>
    ${rows}`;
}

export async function restoreBackup(date) {
  if (!confirm(`確定回復到 ${date} 的備份？\n\n目前資料會先備份（可撤銷），然後用 ${date} 的版本覆蓋。`)) return;
  try {
    const r = await api(`/api/restore/${date}`, { method: 'POST' });
    if (!r.ok) throw new Error(r.detail || '回復失敗');
    toast(`✅ 已回復至 ${date}，重新載入中…`);
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast(`回復失敗：${e.message}`, 'error');
  }
}

// ══ Init ════════════════════════════════════════════════════════════════
export async function init() {
  // Nav click handlers
  document.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', () => goPage(n.dataset.page));
  });
  document.querySelectorAll('.inv-tab').forEach(t => {
    t.addEventListener('click', () => switchInvTab(t.dataset.inv));
  });

  // Top nav mouse wheel horizontal scrolling
  const topNavMenu = document.getElementById('top-nav-menu');
  if (topNavMenu) {
    topNavMenu.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        topNavMenu.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }

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

  // Load core data in parallel — portfolio first so we can render immediately
  await loadPortfolio();
  calcTotals();
  renderDashboard();   // show skeleton with local prices right away

  // Load the rest in parallel (indices is slowest — don't block the first paint)
  await Promise.all([loadManualHistory(), loadHistory(), loadIndices()]);
  calcTotals();
  renderDashboard();   // re-render with fresh indices + history

  // Fetch live prices in background
  refreshPrices().then(() => {
    calcTotals();
    if (currentPage() === 'dashboard') renderDashboard();
    if (currentPage() === 'investments') renderInvestmentsPage();
  });

  // Inject year-filter buttons for Growth chart (2020 → current year)
  const _yearBtnEl = document.getElementById('growth-year-btns');
  if (_yearBtnEl) {
    const _curYr = new Date().getFullYear();
    const _allBtn = `<button class="btn-ghost" style="padding:6px 10px;font-size:12px" onclick="_setChartAll()">All</button>`;
    const _yrBtns = Array.from({length: _curYr - 2020 + 1}, (_, i) => 2020 + i)
      .map(y => `<button class="btn-ghost" style="padding:6px 10px;font-size:12px" onclick="_setChartYear(${y})">${y}</button>`)
      .join('');
    _yearBtnEl.innerHTML = _allBtn + _yrBtns;
  }

  // Auto-sync from Gist on page load (silent, timestamp-based — only pulls if Gist is newer)
  _autoSyncFromGist();

  // Pre-fetch CB/FSC data so stock alert map is ready even without visiting 重要資訊
  _prefetchAlertData();
}

export async function _autoSyncFromGist(retry = true) {
  try {
    const res = await api('/api/sync-from-gist');   // non-force: only pull if Gist newer
    if (!res.ok) {
      console.warn('[auto-sync] Gist not configured or error:', res.error);
      return;
    }

    const pulled    = res.files.filter(f => f.action === 'pulled');
    const anyChange = pulled.length > 0;

    console.log(`[auto-sync] ${res.env} — pulled: ${pulled.length}`,
      res.files.map(f => `${f.name}:${f.action}`).join(', '));

    if (!anyChange) {
      // Railway's background push may not have reached Gist yet — retry once after 4s
      if (retry) setTimeout(() => _autoSyncFromGist(false), 4000);
      return;
    }

    // Reload whichever files were updated
    const names = pulled.map(f => f.name);
    const tasks = [];
    if (names.some(n => n.includes('alm_config'))) tasks.push(loadPortfolio());
    if (names.some(n => n.includes('history')))    tasks.push(loadHistory());
    if (names.some(n => n.includes('manual')))     tasks.push(loadManualHistory());
    await Promise.all(tasks);

    calcTotals();
    await goPage(currentPage());   // re-render whichever page is visible (lazy-loads it if needed)

    const fileList = pulled.map(f => f.name.replace('.json', '')).join(', ');
    toast(`☁️ 已從雲端同步: ${fileList}`);
  } catch (e) {
    console.warn('[auto-sync] gist sync failed:', e);
  }
}

export async function _prefetchAlertData() {
  const today = localISODate();
  // Pull in just the small cb-listed/fsc caches (not the full page render
  // code) so this background warm-up doesn't add to the critical-path bundle.
  const [{ _cbListedCache }, { _fscCache }] = await Promise.all([
    import('./cb-listed.js'),
    import('./fsc.js'),
  ]);
  try {
    if (!_cbListedCache.data || _cbListedCache.date !== today) {
      const d = await api('/api/cb-listed');
      _cbListedCache.data = d; _cbListedCache.date = today;
    }
  } catch(e) { /* silent */ }
  try {
    if (!_fscCache.data || _fscCache.date !== today) {
      const d = await api('/api/fsc-offerings');
      _fscCache.data = d; _fscCache.date = today;
    }
  } catch(e) { /* silent */ }
  // Re-render investments if currently visible so alert stars appear
  if (currentPage() === 'investments' && state.currentInv === 'stock') {
    await goPage('investments');
  }
}
