// Shared mutable app state, caches, and cross-page constants.

/* ══════════════════════════════════════════════════════════════════════════
   HC Finance — Frontend Logic
   ══════════════════════════════════════════════════════════════════════════ */
export const API = '';  // same origin

// Globally unregister datalabels to prevent lifecycle errors on other charts
if (typeof ChartDataLabels !== 'undefined') {
  try {
    Chart.unregister(ChartDataLabels);
  } catch (e) {
    console.warn('Datalabels unregister error:', e);
  }
}

// ── State ────────────────────────────────────────────────────────────────
export const state = {
  portfolio: { assets: [], liabilities: [], investments: [] },
  prices: {},        // ticker -> {price, currency}
  indices: {},       // market indices
  manualHistory: [],
  history: {},       // daily snapshots from alm_history
  privacy: false,
  currentInv: 'stock',  // stock | cb | us
  currentAssetTab: null,
  currentLiabTab: null,
  pnlYear: new Date().getFullYear(),
  usdTwd: 31.77,
  jpyTwd: 0.2,
  excluded: new Set(),  // keys like "assets.0.1" or "assets.0.*"
  mergeSameSymbol: localStorage.getItem('hc_merge_same_symbol') !== '0',  // default on
};

export const _invExpandedGroups = new Set();  // manually-expanded group symbols, per session (default: collapsed)

// Load excluded from localStorage
try {
  const saved = localStorage.getItem('hc_excluded');
  if (saved) state.excluded = new Set(JSON.parse(saved));
} catch (e) {}

export function saveExcluded() {
  localStorage.setItem('hc_excluded', JSON.stringify([...state.excluded]));
}
export function itemKey(section, gi, ii) { return `${section}.${gi}.${ii}`; }
export function groupKey(section, gi) { return `${section}.${gi}.*`; }
export function isExcluded(section, gi, ii) {
  return state.excluded.has(groupKey(section, gi)) || state.excluded.has(itemKey(section, gi, ii));
}

// Returns Set of group names currently excluded (from assets + investments)
export function getExcludedGroupNames() {
  const names = new Set();
  const p = state.portfolio;
  if (!p) return names;
  [['assets', p.assets], ['investments', p.investments]].forEach(([sec, groups]) => {
    (groups || []).forEach((g, gi) => {
      if (state.excluded.has(groupKey(sec, gi))) names.add(g.group);
    });
  });
  return names;
}

// Adjust a history snapshot's net_worth / total_assets by subtracting currently excluded groups.
// Liabilities are left unchanged (no per-group breakdown in history).
export function adjSnap(snap) {
  const exNames = getExcludedGroupNames();
  if (!exNames.size) return snap;
  const ag = snap.asset_groups || {};
  let subtract = 0;
  for (const name of exNames) subtract += ag[name] || 0;
  if (!subtract) return snap;
  return { ...snap, net_worth: (snap.net_worth || 0) - subtract, total_assets: (snap.total_assets || 0) - subtract };
}

export const charts = {};

// ── Constants ────────────────────────────────────────────────────────────
export const CHART_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4',
  '#a855f7', '#f43f5e', '#84cc16', '#3b82f6', '#f97316',
];


export const INV_GROUP_MAP = {
  stock: '股票',
  cb:    '可轉債',
  us:    '美國股市',
};
