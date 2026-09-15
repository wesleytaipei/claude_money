// Entry point. Only the modules needed for first paint are imported
// statically (state/utils/charts/api/dashboard/routing) — every other page
// (assets, investments, growth, history, important, adl, cb-listed, fsc,
// etf, ranking, cb-be, industry, stock-zones) is dynamically import()-ed by
// routing.js's goPage() the first time the user actually navigates there.
// Republish the eager modules' exports onto `window` so the existing inline
// onclick=/onchange= HTML attribute handlers keep working unmodified (lazy
// modules do the same thing themselves once loaded — see routing.js), then
// boot the app. Plain ES modules — no bundler needed.
import * as state_js_ns from './state.js';
import * as utils_js_ns from './utils.js';
import * as charts_js_ns from './charts.js';
import * as api_js_ns from './api.js';
import * as dashboard_js_ns from './dashboard.js';
import * as routing_js_ns from './routing.js';

for (const ns of [
  state_js_ns,
  utils_js_ns,
  charts_js_ns,
  api_js_ns,
  dashboard_js_ns,
  routing_js_ns,
]) {
  Object.assign(window, ns);
}

init();
