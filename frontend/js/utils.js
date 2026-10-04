// Formatting, math, and misc helpers (no app state).

import { state } from './state.js';

// ══ Expression evaluator ═════════════════════════════════════════════════
// Safe recursive-descent parser — no eval/Function(), handles +−*/() only
export function _arithmetic(s) {
  let i = 0;
  function expr() {
    let v = term();
    while (i < s.length && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++]; v = op === '+' ? v + term() : v - term();
    }
    return v;
  }
  function term() {
    let v = factor();
    while (i < s.length && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++]; v = op === '*' ? v * factor() : v / factor();
    }
    return v;
  }
  function factor() {
    if (s[i] === '(') { i++; const v = expr(); if (s[i] !== ')') throw 0; i++; return v; }
    if (s[i] === '-') { i++; return -factor(); }
    const start = i;
    while (i < s.length && /[\d.]/.test(s[i])) i++;
    if (i === start) throw 0;
    return parseFloat(s.slice(start, i));
  }
  const result = expr();
  if (i !== s.length) throw 0;
  return result;
}

export function evalExpr(str) {
  const s = String(str).trim();
  if (!s) return '';
  if (!/^[\d\s+\-*/.()]+$/.test(s)) return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  try {
    const result = _arithmetic(s.replace(/\s+/g, ''));
    if (typeof result === 'number' && isFinite(result)) {
      return (+result.toFixed(10)).toString();
    }
  } catch (e) { /* leave as-is */ }
  return s;
}

// Global blur handler — evaluate arithmetic in any decimal input
document.addEventListener('blur', (e) => {
  const el = e.target;
  if (el.tagName !== 'INPUT') return;
  if (el.getAttribute('inputmode') !== 'decimal') return;
  const evaluated = evalExpr(el.value);
  if (evaluated !== el.value) {
    el.value = evaluated;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, true);

// ══ Utils ═══════════════════════════════════════════════════════════════
export function fmt(n, currency = 'TWD') {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (currency === 'USD') return 'US$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === 'JPY') return '¥' + Math.round(n).toLocaleString();
  if (Math.abs(n) >= 1e8) return 'NT$' + (n / 1e8).toFixed(2) + '億';
  if (Math.abs(n) >= 1e4) return 'NT$' + (n / 1e4).toFixed(1) + '萬';
  return 'NT$' + Math.round(n).toLocaleString();
}

export function fmtFull(n) {
  if (n == null || isNaN(n)) return '—';
  return 'NT$ ' + Math.round(n).toLocaleString();
}

export function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + Number(n).toFixed(digits) + '%';
}

export function toTWD(amount, currency) {
  if (!currency || currency === 'TWD') return amount;
  if (currency === 'USD') return amount * state.usdTwd;
  if (currency === 'JPY') return amount * state.jpyTwd;
  return amount;
}

// Format price with 2 decimal places
export function fmtPrice(n) {
  if (n == null || isNaN(n) || Number(n) === 0) return '—';
  return Number(n).toFixed(2);
}

export function pnlClass(v) {
  if (v > 0) return 'profit';
  if (v < 0) return 'loss';
  return 'muted';
}

// Local calendar date as YYYY-MM-DD. `date.toISOString().slice(0,10)` converts
// to UTC first, which silently rolls back to "yesterday" for UTC+8 (Taiwan)
// users between 00:00-07:59 local time — use this instead wherever "today"
// means the viewer's local calendar date.
export function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr.replace(/\//g, '-'));
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

export function dateWarnClass(dateStr) {
  const d = daysUntil(dateStr);
  if (d == null) return '';
  if (d < 90) return 'cell-warn-red';
  if (d < 180) return 'cell-warn-orange';
  return '';
}

export function percentWarnClass(pct, redThr, orangeThr) {
  if (pct == null) return '';
  if (pct < redThr) return 'cell-warn-red';
  if (pct < orangeThr) return 'cell-warn-orange';
  return '';
}

export function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2400);
}

// Generic "in-flight" feedback for any 更新/重新整理/🔄 button: disables the button,
// swaps its label for a spinner while `fn` is awaited, then restores it and toasts
// the outcome — so a click never looks like it did nothing while data is loading.
export async function withBtnSpinner(event, fn) {
  const btn = event?.currentTarget || event?.target?.closest?.('button');
  if (!btn || btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 更新中…';
  try {
    await fn();
    toast('✅ 已更新');
  } catch (e) {
    toast('❌ 更新失敗：' + (e?.message || e), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}


export function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
