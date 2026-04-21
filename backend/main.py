"""HC Finance Web — FastAPI backend"""
import json
import logging
import time
import re
from datetime import datetime, timedelta
from pathlib import Path

import urllib3
import requests as http_requests

import yfinance as yf
from fastapi import FastAPI, Request

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

import sys
import os

try:
    from dotenv import load_dotenv
    # Use absolute path for .env file to ensure it's found regardless of where the app starts
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    load_dotenv(env_path)
except ImportError:
    pass

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from info_scraper import scrape_important_info

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hc_finance")

app = FastAPI(title="HC Finance")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
INITIAL_DATA_DIR = BASE_DIR / "initial_data"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

# ── Seed data logic ──────────────────────────────────────────────────────────
def ensure_data_seeded():
    """Merge INITIAL_DATA_DIR into DATA_DIR if the latter is missing history."""
    import shutil
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not INITIAL_DATA_DIR.exists():
        return

    for f in INITIAL_DATA_DIR.glob("*.json"):
        target = DATA_DIR / f.name
        if not target.exists():
            shutil.copy(f, target)
        else:
            # Merge logic for JSON files (especially history)
            try:
                with open(f, "r", encoding="utf-8") as source_f:
                    source_data = json.load(source_f)
                with open(target, "r", encoding="utf-8") as target_f:
                    curr_data = json.load(target_f)
                
                if isinstance(source_data, dict) and isinstance(curr_data, dict):
                    # For dicts, let Git (source) override existing keys to allow "Push to Update"
                    # but keep keys that only exist in Production (e.g. dynamic state)
                    merged = {**curr_data, **source_data}
                    with open(target, "w", encoding="utf-8") as target_f:
                        json.dump(merged, target_f, ensure_ascii=False, indent=2)
                elif isinstance(source_data, list) and isinstance(curr_data, list):
                    # Update/Merge lists (unique by 'date', source overrides if date mismatch)
                    new_data_map = {it.get("date"): it for it in source_data if isinstance(it, dict) and it.get("date")}
                    
                    # Filter out Production entries being updated by Git
                    merged_list = [it for it in curr_data if not (isinstance(it, dict) and it.get("date") in new_data_map)]
                    merged_list.extend(source_data)
                    merged_list.sort(key=lambda x: str(x.get("date", "")))
                    
                    with open(target, "w", encoding="utf-8") as target_f:
                        json.dump(merged_list, target_f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"Error merging {f.name}: {e}")

ensure_data_seeded()

CONFIG_FILE = DATA_DIR / "alm_config.json"
HISTORY_FILE = DATA_DIR / "history.json"
MANUAL_HISTORY_FILE = DATA_DIR / "manual_history.json"

_price_cache: dict = {}
_tw_mis_cache: dict = {}   # symbol → {price, change_pct, name, ts}
_indices_cache: dict = {"ts": 0, "data": {}}
CACHE_TTL = 300  # 5 minutes


# ── IO helpers (Gist + Local) ────────────────────────────────────────────────
GIST_ID = os.getenv("GIST_ID")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

if GIST_ID and GITHUB_TOKEN:
    print(f"INFO: [Gist] Sync enabled. Gist ID: {GIST_ID[:5]}***")
else:
    print("WARNING: [Gist] Sync disabled. GIST_ID or GITHUB_TOKEN not found in environment.")

def load_json(path: Path, default):
    # 1. Try fetching from GitHub Gist first
    if GIST_ID and GITHUB_TOKEN:
        try:
            headers = {"Authorization": f"token {GITHUB_TOKEN}"}
            r = http_requests.get(f"https://api.github.com/gists/{GIST_ID}", headers=headers, timeout=10)
            if r.status_code == 200:
                files = r.json().get("files", {})
                if path.name in files:
                    content = files[path.name].get("content")
                    if content:
                        # Write what we fetched to local as a backup
                        path.parent.mkdir(parents=True, exist_ok=True)
                        with open(path, "w", encoding="utf-8") as f:
                            f.write(content)
                        return json.loads(content)
        except Exception as e:
            logger.error(f"[Gist] load_json failed for {path.name}: {e}. Falling back to local.")

    # 2. Fall back to local file
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

def save_json(path: Path, data):
    # 1. Always save locally
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # 2. Sync to GitHub Gist
    if GIST_ID and GITHUB_TOKEN:
        try:
            headers = {
                "Authorization": f"token {GITHUB_TOKEN}",
                "Accept": "application/vnd.github.v3+json"
            }
            # Update only the specific file in the Gist
            payload = {
                "files": {
                    path.name: {
                        "content": json.dumps(data, ensure_ascii=False, indent=2)
                    }
                }
            }
            r = http_requests.patch(f"https://api.github.com/gists/{GIST_ID}", headers=headers, json=payload, timeout=10)
            if r.status_code != 200:
                logger.error(f"[Gist] save_json error for {path.name}: {r.status_code} {r.text}")
        except Exception as e:
            logger.error(f"[Gist] save_json exception for {path.name}: {e}")


# ── Price fetching ───────────────────────────────────────────────────────────
def _resolve_ticker(symbol: str, market: str) -> str:
    """Convert a raw symbol to a yfinance ticker."""
    s = symbol.strip().upper()
    if market == "tw":
        if not (s.endswith(".TW") or s.endswith(".TWO")):
            # Taiwan stocks use .TW; fallback to .TWO (OTC) handled separately
            return f"{s}.TW"
    return s


def fetch_prices(tickers: list[str]) -> dict:
    now = time.time()
    result = {}
    to_fetch = []

    for t in tickers:
        cached = _price_cache.get(t)
        if cached and (now - cached["ts"]) < CACHE_TTL:
            result[t] = cached
        else:
            to_fetch.append(t)

    if to_fetch:
        try:
            tkrs = yf.Tickers(" ".join(to_fetch))
            for t in to_fetch:
                try:
                    fi = tkrs.tickers[t].fast_info
                    price = fi.last_price
                    prev_close = getattr(fi, "previous_close", None)
                    change_pct = None
                    if price and prev_close and float(prev_close) > 0:
                        change_pct = round((float(price) - float(prev_close)) / float(prev_close) * 100, 2)
                    currency = getattr(fi, "currency", None) or "TWD"
                    entry = {
                        "price":      round(float(price), 4) if price else None,
                        "change_pct": change_pct,
                        "currency":   currency,
                        "ts":         now,
                    }
                    _price_cache[t] = entry
                    result[t] = entry
                except Exception as e:
                    err = {"price": None, "change_pct": None, "currency": "N/A", "error": str(e), "ts": now}
                    _price_cache[t] = err
                    result[t] = err
        except Exception as e:
            for t in to_fetch:
                result[t] = {"price": None, "change_pct": None, "currency": "N/A", "error": str(e), "ts": now}

    return result


def _mis_parse_price(item: dict) -> tuple[float | None, float | None]:
    """Extract (price, change_pct) from a single MIS msgArray item."""
    z_raw = item.get("z", "-") or "-"
    y_raw = item.get("y", "-") or "-"
    b_raw = item.get("b", "") or ""

    price = None
    for raw in [z_raw, b_raw.split("_")[0], y_raw]:
        try:
            v = float(raw)
            if v > 0:
                price = round(v, 2)
                break
        except (ValueError, TypeError):
            pass

    change_pct = None
    try:
        z = float(z_raw)
        y = float(y_raw)
        if z > 0 and y > 0:
            change_pct = round((z - y) / y * 100, 2)
    except (ValueError, TypeError):
        pass

    # Fallback: if z was unavailable but we resolved a price from b/y, use that
    if change_pct is None and price is not None:
        try:
            y = float(y_raw)
            if y > 0:
                change_pct = round((price - y) / y * 100, 2)
        except (ValueError, TypeError):
            pass

    return price, change_pct


def _fetch_yahoo_tw_scrape(symbol: str, market: str = "tse") -> dict:
    """Scrape Yahoo Finance Taiwan for price + change_pct (reliable for TW stocks/indices)."""
    if symbol.startswith('^'):
        url = f"https://tw.stock.yahoo.com/quote/{symbol}"
    else:
        suffix = ".TWO" if market == "otc" else ".TW"
        url = f"https://tw.stock.yahoo.com/quote/{symbol}{suffix}"
        
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        r = http_requests.get(url, headers=headers, timeout=10)
        html = r.text
        
        # 1. Capture Price
        price_m = re.search(r'"regularMarketPrice":([0-9]+\.?[0-9]*)', html)
        if not price_m:
            price_m = re.search(r'"regularMarketPrice":\{"raw":([0-9]+\.?[0-9]*)', html)
        
        price = float(price_m.group(1)) if price_m else None
        
        # 2. Capture Percentage and Sign
        # Taiwan convention: c-trend-up = Red (+), c-trend-down = Green (-)
        pct = 0.0
        # Improved regex to handle (0.78%) or 6.10% formats
        pct_matches = re.findall(r'>\s*\(?([-+0-9.]+%)\)?\s*<', html)
        if not pct_matches:
            # Fallback: catch any text string ending with % inside a tag
            pct_matches = re.findall(r'>([^<]*?[\d.]+%)<', html)

        if pct_matches:
            # The first one is usually the day change percentage
            pct_str = pct_matches[0].replace('%', '').replace('(', '').replace(')', '').replace('+', '').strip()
            try:
                pct = float(pct_str)
                # Sign detection: look for the color classes c-trend-up/down in the HTML
                # These classes are applied to the parent or nearby span of the price/change info
                # We'll look at the block of HTML around the first price/percentage occurrence
                idx = html.find(pct_matches[0])
                search_area = html[max(0, idx-1000) : idx+200]
                
                if 'c-trend-down' in search_area:
                    pct = -abs(pct)
                elif 'c-trend-up' in search_area:
                    pct = abs(pct)
            except: pass
            
        if price:
            return {"price": price, "change_pct": pct}
    except Exception as e:
        logger.warning(f"[yahoo-scrape] {symbol} failed: {e}")
    return {}


def fetch_tw_prices_mis(symbols: list[str]) -> dict:
    """Batch-fetch TW stock prices + day-change% from TWSE MIS API.

    Works for both TSE (上市) and OTC (上櫃) stocks — the market exchange
    is resolved via _tw_table; unknown symbols are tried as TSE first.
    """
    now = time.time()
    result: dict = {}
    to_fetch: list[str] = []

    for sym in symbols:
        cached = _tw_mis_cache.get(sym)
        # Only use cache if it has both price AND change_pct; otherwise retry fallbacks
        if cached and (now - cached["ts"]) < CACHE_TTL and cached.get("change_pct") is not None:
            result[sym] = cached
        else:
            to_fetch.append(sym)

    if not to_fetch:
        return result

    # FORCE CLEAR CACHE for this request to ensure scraper logic takes effect
    # _tw_mis_cache.clear() 
    # v2: ensuring correct fallback for missing percentages (e.g. 6826)
    by_sym = _tw_table.get("by_symbol", {})
    parts = []
    for sym in to_fetch:
        entry = by_sym.get(sym)
        if entry:
            # Known symbol — use exact market
            parts.append(f"{entry['market']}_{sym.lower()}.tw")
        else:
            # Unknown symbol — try all three exchanges; MIS returns whichever exists
            parts += [f"tse_{sym.lower()}.tw", f"otc_{sym.lower()}.tw", f"emg_{sym.lower()}.tw"]

    ex_ch = "|".join(parts)
    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex_ch}"
    headers = {"User-Agent": "Mozilla/5.0"}

    try:
        r = http_requests.get(url, headers=headers, timeout=10, verify=False)
        found: set[str] = set()
        for item in r.json().get("msgArray", []):
            code = (item.get("c") or "").strip().upper()
            if not code:
                continue
            price, change_pct = _mis_parse_price(item)
            entry = {
                "price":      price,
                "change_pct": change_pct,
                "name":       item.get("n", ""),
                "ts":         now,
            }
            _tw_mis_cache[code] = entry
            result[code] = entry
            found.add(code)

        # Symbols with null data or not found or missing change_pct → try Yahoo Scrape / yfinance
        for sym in to_fetch:
            # Even if found in MIS, if price was Null or change_pct was Null, we want fallback
            # (MIS often reports price but '-' for z during off-hours, missing the % change)
            if sym not in found or result[sym].get("price") is None or result[sym].get("change_pct") is None:
                entry = by_sym.get(sym, {})
                market = entry.get("market", "tse")
                
                # 1. Try Yahoo Scrape (Best for TW stocks accurate change%)
                yahoo = _fetch_yahoo_tw_scrape(sym, market)
                if yahoo.get("price"):
                    hit = {
                        "price":      yahoo["price"],
                        "change_pct": yahoo["change_pct"],
                        "name":       yahoo.get("name", entry.get("name", "")),
                        "ts":         now,
                    }
                    _tw_mis_cache[sym] = hit
                    result[sym] = hit
                    found.add(sym)
                    continue

                # 2. Try yfinance fallback — try both suffixes so 6-char symbols
                #    like 00988A work even when _tw_table market is unknown
                suffixes = [".TWO", ".TW"] if market == "otc" else [".TW", ".TWO"]
                yf_hit = None
                for suffix in suffixes:
                    yf_sym = f"{sym}{suffix}"
                    try:
                        fi = yf.Ticker(yf_sym).fast_info
                        price = round(float(fi.last_price), 2) if getattr(fi, "last_price", None) else None
                        if price:
                            prev = float(getattr(fi, "previous_close", None) or 0)
                            change_pct = round((price - prev) / prev * 100, 2) if prev > 0 else None
                            yf_hit = {"price": price, "change_pct": change_pct, "name": entry.get("name", ""), "ts": now}
                            break
                    except Exception:
                        continue
                if yf_hit:
                    _tw_mis_cache[sym] = yf_hit
                    result[sym] = yf_hit
                    found.add(sym)
                else:
                    # Final miss
                    if sym not in result:
                        miss = {"price": None, "change_pct": None, "name": entry.get("name", ""), "ts": now}
                        _tw_mis_cache[sym] = miss
                        result[sym] = miss

    except Exception as e:
        logger.error(f"[tw-prices] MIS fetch failed: {e}")
        for sym in to_fetch:
            if sym not in result:
                result[sym] = {"price": None, "change_pct": None, "name": "", "ts": now}

    return result


def _fetch_tw_indices_mis() -> dict:
    """Fetch TAIEX and OTC index from TWSE MIS API (real-time, reliable)."""
    url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw|otc_o00.tw"
    key_map = {"t00": "taiex", "o00": "otc"}
    result = {}
    try:
        r = http_requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=8, verify=False)
        for item in r.json().get("msgArray", []):
            code = (item.get("c") or "").strip()
            key = key_map.get(code)
            if not key:
                continue
            # Index: 'z' = current value; 'y' = previous close
            z_raw = item.get("z") or item.get("i") or "-"
            y_raw = item.get("y") or "-"
            current, prev = None, None
            try:
                current = round(float(z_raw), 2)
            except (ValueError, TypeError):
                pass
            try:
                prev = float(y_raw)
            except (ValueError, TypeError):
                pass
            if current:
                change = round(current - prev, 2) if prev else 0
                pct    = round((current - prev) / prev * 100, 2) if prev and prev > 0 else 0
                result[key] = {"price": current, "change": change, "change_pct": pct}
    except Exception as e:
        logger.warning(f"[indices] MIS TW fetch failed: {e}")
    return result


def fetch_indices() -> dict:
    now = time.time()
    # Cache temporarily disabled to force refresh with corrected MIS logic
    # if _indices_cache["ts"] and (now - _indices_cache["ts"]) < CACHE_TTL:
    #     return _indices_cache["data"]

    # US indices + FX via yfinance
    us_index_tickers = {
        "dji":    "^DJI",
        "nasdaq": "^IXIC",
        "sox":    "^SOX",
        "btc":    "BTC-USD",
    }
    fx_tickers = {"usd_twd": "USDTWD=X", "jpy_twd": "JPYTWD=X"}

    result = {}

    # TW indices via MIS (more accurate than yfinance for TAIEX/OTC)
    result.update(_fetch_tw_indices_mis())

    # Fallback for TW indices if MIS is blank (weekends/holidays)
    tw_fallback = {"taiex": "^TWII", "otc": "^TWOII"}
    for key, sym in tw_fallback.items():
        if not result.get(key) or result[key].get("price") is None:
             # Try Yahoo Scrape for indices first (consistent with E:\money)
             yahoo = _fetch_yahoo_tw_scrape(sym, "tse" if key == "taiex" else "otc")
             if yahoo.get("price"):
                  p = yahoo["price"]
                  pct = yahoo["change_pct"]
                  # Calculate absolute change back from percentage
                  prev = p / (1 + pct/100) if (1 + pct/100) != 0 else p
                  change = round(p - prev, 2)
                  result[key] = {"price": p, "change": change, "change_pct": pct}
             else:
                 # Standard yfinance fallback
                 try:
                     fi = yf.Ticker(sym).fast_info
                     price = float(fi.last_price or 0)
                     prev  = float(getattr(fi, "previous_close", None) or 0)
                     if price > 0:
                         change = price - prev if prev else 0
                         pct    = (change / prev * 100) if prev else 0
                         result[key] = {"price": round(price, 2), "change": round(change, 2), "change_pct": round(pct, 2)}
                 except Exception:
                     pass

    try:
        all_yf = list(us_index_tickers.values()) + list(fx_tickers.values())
        tkrs = yf.Tickers(" ".join(all_yf))

        for key, sym in us_index_tickers.items():
            try:
                fi = tkrs.tickers[sym].fast_info
                price = float(fi.last_price or 0)
                prev  = float(getattr(fi, "previous_close", None) or 0)
                change = price - prev if prev else 0
                pct    = (change / prev * 100) if prev else 0
                result[key] = {
                    "price": round(price, 2),
                    "change": round(change, 2),
                    "change_pct": round(pct, 2),
                }
            except Exception:
                result[key] = None

        for key, sym in fx_tickers.items():
            try:
                fi = tkrs.tickers[sym].fast_info
                result[key] = round(float(fi.last_price), 4)
            except Exception:
                result[key] = None
    except Exception as e:
        result["error"] = str(e)

    _indices_cache["data"] = result
    _indices_cache["ts"] = now
    return result


_cb_cache: dict = {"ts": 0, "data": {}}


CBAS_CACHE_TTL = 300  # 5 min
_cbas_cache: dict = {"ts": 0, "data": {}}  # bond_code -> full CB info

# ── CB Suspension (停止轉換) ──────────────────────────────────────────────────
# data: {code: "2026/04/13 - 2026/06/11"} for currently suspended CBs
_cb_suspension_cache: dict = {"ts": 0, "data": {}}
CB_SUSPENSION_TTL = 3600  # 1 hour

# ── TDCC Remaining Registration (剩餘張數, authoritative source) ──────────────
# TDCC open-data CSV id=1-16 "發行公司無實體發行登記統計" (daily-updated).
# Format: 資料日,證券代號,證券名稱,市場別,證券種類,登記數額
# 登記數額 unit: for CBs it is 張 (NT$100,000 face each). This is more
# up-to-date than CBAS's `circulating_balance` which can lag by days.
_tdcc_remain_cache: dict = {"ts": 0, "data": {}}   # {code: int_amount}
TDCC_REMAIN_TTL = 21600  # 6 hours (CSV refreshes daily)


def load_tdcc_remain() -> dict:
    """Fetch TDCC '無實體發行登記' CSV and return {code: 登記數額} dict."""
    now = time.time()
    if _tdcc_remain_cache["ts"] and (now - _tdcc_remain_cache["ts"]) < TDCC_REMAIN_TTL:
        return _tdcc_remain_cache["data"]

    url = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-16"
    result: dict = {}
    try:
        r = http_requests.get(url, headers={"User-Agent": "Mozilla/5.0"},
                              timeout=30, verify=False)
        # CSV is UTF-8 with BOM. Header: 資料日,證券代號,證券名稱,市場別,證券種類,登記數額
        text = r.content.decode("utf-8-sig", errors="ignore")
        lines = text.split("\n")
        for ln in lines[1:]:
            parts = ln.strip().split(",")
            if len(parts) < 6:
                continue
            code = parts[1].strip()
            amount_s = parts[5].strip()
            if not code or not amount_s:
                continue
            try:
                result[code] = int(float(amount_s.replace(",", "")))
            except ValueError:
                continue
        logger.info(f"[tdcc-remain] loaded {len(result)} registrations")
        _tdcc_remain_cache["data"] = result
        _tdcc_remain_cache["ts"] = now
    except Exception as e:
        logger.error(f"[tdcc-remain] fetch failed: {e}")
        return _tdcc_remain_cache.get("data", {})
    return result


def load_cb_suspensions() -> dict:
    """Fetch TPEX 停止轉換 CSV via JSON index; return dict {code: "start - end"} for suspended CBs.

    CSV format (Big5 encoded):
        TITLE,...
        DATADATE,...
        ALIGN,...
        HEADER,債券代碼,債券簡稱,停止開始日,停止結束日,停止事由
        BODY,"15142 ","亞力二    ","2026/04/13","2026/06/11","股東常會  "
    """
    import csv, io
    now = time.time()
    if _cb_suspension_cache["ts"] and (now - _cb_suspension_cache["ts"]) < CB_SUSPENSION_TTL:
        return _cb_suspension_cache["data"]

    today = datetime.now().date()
    suspended: dict = {}  # code → "YYYY/MM/DD - YYYY/MM/DD"

    # Step 1: Get latest CSV URL from TPEX JSON API
    # Response: {"tables":[{"data":[["115/04/13", "/path/xls", "/path/csv"], ...]}], "stat":"ok"}
    csv_url = None
    try:
        api_r = http_requests.get(
            "https://www.tpex.org.tw/www/zh-tw/bond/cbSuspend?response=json&limit=100&offset=0",
            timeout=10, verify=False,
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
        )
        data = api_r.json()
        tables = data.get("tables", [])
        if tables:
            rows = tables[0].get("data", [])
            if rows:
                path = rows[0][2]  # index 2 = CSV path
                if path and not path.startswith("http"):
                    path = "https://www.tpex.org.tw" + path
                csv_url = path
                logger.info(f"[cb-suspension] latest CSV from JSON API: {csv_url}")
    except Exception as e:
        logger.warning(f"[cb-suspension] JSON index failed: {e}")

    # Step 2: Fallback — try today and recent trading days directly
    if not csv_url:
        for days_back in range(7):
            d = today - timedelta(days=days_back)
            yyyy     = d.strftime("%Y")
            yyyymm   = d.strftime("%Y%m")
            yyyymmdd = d.strftime("%Y%m%d")
            url = (f"https://www.tpex.org.tw/storage/bond_zone/tradeinfo/cb/"
                   f"{yyyy}/{yyyymm}/RSdrs002.{yyyymmdd}-C.csv")
            try:
                r = http_requests.head(url, timeout=5, verify=False,
                                       headers={"User-Agent": "Mozilla/5.0"})
                if r.status_code == 200:
                    csv_url = url
                    logger.info(f"[cb-suspension] found via HEAD: {csv_url}")
                    break
            except Exception:
                continue

    if not csv_url:
        logger.warning("[cb-suspension] could not locate any CSV file")
        _cb_suspension_cache["ts"] = now
        return suspended

    # Step 3: Fetch and parse
    try:
        r = http_requests.get(csv_url, timeout=15, verify=False,
                              headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()

        # File is Big5 / CP950 encoded
        text = None
        for enc in ("big5", "cp950", "utf-8-sig", "utf-8"):
            try:
                text = r.content.decode(enc)
                break
            except (UnicodeDecodeError, LookupError):
                continue
        if text is None:
            text = r.content.decode("big5", errors="replace")

        # Each data row: BODY,"15142 ","亞力二","2026/04/13","2026/06/11","..."
        reader = csv.reader(io.StringIO(text))
        for row in reader:
            if not row or row[0].strip().upper() != "BODY":
                continue
            if len(row) < 5:
                continue
            code = row[1].strip().strip('"').strip()
            if not re.match(r'^\d{5}$', code):
                continue

            # Dates are AD (西元) format: 2026/04/13
            def _parse_ad(s: str):
                s = s.strip().strip('"').strip()
                try:
                    return datetime.strptime(s, "%Y/%m/%d").date()
                except Exception:
                    return None

            start_d = _parse_ad(row[3])
            end_d   = _parse_ad(row[4])

            WARN_DAYS = 10  # light up red N days before suspension starts
            if start_d and end_d:
                warn_d = start_d - timedelta(days=WARN_DAYS)
                if warn_d <= today <= end_d:
                    suspended[code] = f"{start_d.strftime('%Y/%m/%d')} - {end_d.strftime('%Y/%m/%d')}"
                    logger.info(f"[cb-suspension] {code} suspended {start_d}~{end_d}")
            elif start_d and (start_d - timedelta(days=WARN_DAYS)) <= today:
                suspended[code] = start_d.strftime('%Y/%m/%d')

        logger.info(f"[cb-suspension] total {len(suspended)} suspended CBs from {csv_url}")
    except Exception as e:
        logger.error(f"[cb-suspension] parse failed {csv_url}: {e}")

    _cb_suspension_cache["data"] = suspended
    _cb_suspension_cache["ts"] = now
    return suspended


def load_cbas_data() -> dict:
    """Load all CB data from CBAS API (cached). Returns dict keyed by bond_code."""
    now = time.time()
    if _cbas_cache["ts"] and (now - _cbas_cache["ts"]) < CBAS_CACHE_TTL:
        return _cbas_cache["data"]

    url = "https://cbas16889.pscnet.com.tw/api/CbasQuote/GetIssuedCBSchedule"
    try:
        r = http_requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20, verify=False)
        raw = r.json()
        cb_list = raw.get("result", raw) if isinstance(raw, dict) else raw
        result = {}
        for item in cb_list:
            code = str(item.get("bond_code", "")).strip()
            if not code:
                continue

            def _f(k):
                v = item.get(k)
                try:
                    return float(v) if v not in (None, "", "-") else None
                except (ValueError, TypeError):
                    return None

            # CB market price from CBAS (more reliable than mis API in some cases)
            cb_price = _f("convertible_bond_market_price")

            result[code] = {
                "name":              item.get("underlying_bond", ""),
                "price":             cb_price,
                "cb_due_date":       item.get("expiry_date", ""),
                "issued_shares":     (_f("circulation") or 0) * 1000,
                "remain_shares":     _f("circulating_balance"),
                "balance_ratio":     _f("balance_ratio"),
                "conversion_price":  _f("conversion_price"),
                "premium_rate":      _f("premium_rate"),
                "stock_price":       _f("underlying_stock_market_price"),
                "conversion_value":  _f("conversion_value"),
                "convert_target":    item.get("convert_target_code", ""),
                "ts": now,
            }
        _cbas_cache["data"] = result
        _cbas_cache["ts"] = now
        return result
    except Exception as e:
        return _cbas_cache.get("data", {})


def fetch_cb_prices(symbols: list[str]) -> dict:
    """Fetch CB data. Primary: CBAS API (full data). Fallback: TWSE mis API (price only)."""
    cbas = load_cbas_data()
    now = time.time()
    result = {}

    # Symbols not found in CBAS — try mis API for price
    missing = [s for s in symbols if s not in cbas]

    if missing:
        ex_ch = "|".join(f"otc_{s}.tw" for s in missing)
        url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex_ch}"
        try:
            r = http_requests.get(url, timeout=10, verify=False)
            for item in r.json().get("msgArray", []):
                code = item.get("c", "")
                price = None
                for field in ["z", None, "y"]:
                    if field is None:
                        b = item.get("b", "")
                        if b and b != "-":
                            try: price = float(b.split("_")[0])
                            except: pass
                        if price: break
                        continue
                    val = item.get(field, "-")
                    if val and val != "-":
                        try: price = float(val)
                        except: pass
                    if price: break
                # Compute day change % from z (current) vs y (prev close)
                change_pct = None
                try:
                    z = float(item.get("z", "-") or "-")
                    y = float(item.get("y", "-") or "-")
                    if z and y and y > 0:
                        change_pct = round((z - y) / y * 100, 2)
                except (ValueError, TypeError):
                    pass
                cbas[code] = {
                    "name":       item.get("n", ""),
                    "price":      round(price, 4) if price else None,
                    "change_pct": change_pct,
                    "ts":         now,
                }
        except Exception:
            pass

    for s in symbols:
        result[s] = cbas.get(s, {"price": None, "name": "", "ts": now})

    # ── Mark suspended CBs ─────────────────────────────────────────────────
    suspensions = load_cb_suspensions()  # {code: "start - end"}
    for s in symbols:
        date_range = suspensions.get(s)
        result[s]["suspended"]       = date_range is not None
        result[s]["suspension_dates"] = date_range  # e.g. "2026/04/13 - 2026/06/11" or None

    # ── Override remain_shares with TDCC open-data (authoritative) ─────────
    # TDCC's "無實體發行登記統計" is the official daily source of outstanding
    # CB registration in 張. CBAS's circulating_balance often lags by days.
    tdcc = load_tdcc_remain()
    for s in symbols:
        amt = tdcc.get(s)
        if amt is not None:
            result[s]["remain_shares"] = amt
            issued = result[s].get("issued_shares")
            if issued and issued > 0:
                result[s]["balance_ratio"] = round(amt / issued * 100, 2)

    # ── Collect underlying stock codes from CBAS (convert_target) ──────────
    target_map: dict[str, str] = {}   # cb_code → underlying_stock_code
    for s in symbols:
        target = (result[s].get("convert_target") or "").strip().upper()
        if not target and len(s) == 5 and s.isdigit():
            # Fallback: derive underlying code from CB code (drop last digit)
            target = s[:4]
        if target:
            target_map[s] = target

    # ── Supplement price + change_pct from MIS for ALL CB symbols ─────────
    # CBAS's convertible_bond_market_price is the previous close and can be
    # stale for suspended / low-volume CBs. MIS gives live last-trade / best-bid.
    # IMPORTANT: do NOT use _tw_table[by_sym] here — that table catalogues the
    # underlying stock's market (which may be TSE), while the CB itself always
    # trades on OTC/TPEX. Always query both exchanges.
    cb_parts = []
    for s in symbols:
        cb_parts += [f"otc_{s.lower()}.tw", f"tse_{s.lower()}.tw"]
    try:
        mis_url = ("https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
                   f"?ex_ch={'|'.join(cb_parts)}")
        mis_r = http_requests.get(mis_url, headers={"User-Agent": "Mozilla/5.0"},
                                  timeout=10, verify=False)
        for item in mis_r.json().get("msgArray", []):
            code = (item.get("c") or "").strip()
            if code in result:
                mis_price, change_pct = _mis_parse_price(item)
                # MIS is the authoritative live source (z > best bid > prev close).
                # CBAS's convertible_bond_market_price is often stale (esp. for
                # suspended / low-volume CBs), so override with MIS when present.
                if mis_price is not None:
                    result[code]["price"] = mis_price
                if change_pct is not None:
                    result[code]["change_pct"] = change_pct
    except Exception:
        pass

    # ── Fetch underlying stock change_pct (for CB table display) ───────────
    if target_map:
        unique_targets = list(set(target_map.values()))
        stock_data = fetch_tw_prices_mis(unique_targets)
        for cb_code, stock_code in target_map.items():
            sp = stock_data.get(stock_code, {})
            result[cb_code]["stock_change_pct"] = sp.get("change_pct")

    return result


# ── API routes ───────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/portfolio")
def get_portfolio():
    return load_json(CONFIG_FILE, {"assets": [], "liabilities": [], "investments": []})


@app.post("/api/portfolio")
async def post_portfolio(request: Request):
    data = await request.json()
    save_json(CONFIG_FILE, data)
    return {"ok": True}


@app.get("/api/prices")
def get_prices(tickers: str = ""):
    if not tickers.strip():
        return {}
    tks = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    return fetch_prices(tks)


@app.get("/api/tw-prices")
def get_tw_prices(symbols: str = ""):
    """MIS-based TW stock prices (TSE + OTC) with day-change%."""
    if not symbols.strip():
        return {}
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return fetch_tw_prices_mis(syms)


@app.get("/api/cb-prices")
def get_cb_prices(symbols: str = ""):
    if not symbols.strip():
        return {}
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return fetch_cb_prices(syms)


def _entry_to_lookup(symbol: str, entry: dict) -> dict:
    return {
        "symbol":           symbol,
        "name":             entry.get("name", ""),
        "price":            entry.get("price"),
        "cb_due_date":      entry.get("cb_due_date", ""),
        "issued_shares":    entry.get("issued_shares"),
        "remain_shares":    entry.get("remain_shares"),
        "balance_ratio":    entry.get("balance_ratio"),
        "conversion_price": entry.get("conversion_price"),
        "premium_rate":     entry.get("premium_rate"),
        "stock_price":      entry.get("stock_price"),
        "conversion_value": entry.get("conversion_value"),
        "convert_target":   entry.get("convert_target", ""),
    }


@app.get("/api/cb-lookup")
def cb_lookup(symbol: str = "", name: str = ""):
    symbol = symbol.strip()
    name = name.strip()

    cbas = load_cbas_data()

    if symbol:
        if symbol in cbas:
            return _entry_to_lookup(symbol, cbas[symbol])
        # fallback: fetch price from mis API
        data = fetch_cb_prices([symbol])
        return _entry_to_lookup(symbol, data.get(symbol, {}))

    if name:
        # Search CBAS by name
        for sym, entry in cbas.items():
            if entry.get("name") == name:
                return _entry_to_lookup(sym, entry)
        # Search portfolio
        portfolio = load_json(CONFIG_FILE, {"assets": [], "liabilities": [], "investments": []})
        for g in portfolio.get("investments", []):
            if g.get("group") != "可轉債":
                continue
            for item in g.get("items", []):
                if item.get("name") == name:
                    sym = item.get("symbol", "")
                    if sym and sym in cbas:
                        return _entry_to_lookup(sym, cbas[sym])
        return {"symbol": "", "name": name, "error": "not_found"}

    return {}


# Cache for TWSE + OTC full stock list (name → symbol)
# ── TW Stock Table (ISIN-based, weekly rebuild) ──────────────────────────────
TW_TABLE_FILE = DATA_DIR / "tw_stock_table.json"

# in-memory: {by_symbol: {sym: {name, market}}, by_name: {name: sym}, updated, count}
_tw_table: dict = {"by_symbol": {}, "by_name": {}, "updated": None, "count": 0}

_ISIN_SOURCES = [
    ("https://isin.twse.com.tw/isin/C_public.jsp?strMode=2", "tse"),  # 上市股票
    ("https://isin.twse.com.tw/isin/C_public.jsp?strMode=3", "tse"),  # 上市 ETF/受益憑證
    ("https://isin.twse.com.tw/isin/C_public.jsp?strMode=4", "otc"),  # 上櫃股票
    ("https://isin.twse.com.tw/isin/C_public.jsp?strMode=5", "otc"),  # 上櫃 ETF/受益憑證
    ("https://isin.twse.com.tw/isin/C_public.jsp?strMode=7", "emg"),  # 興櫃股票
]

_ISIN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Referer": "https://isin.twse.com.tw/",
}


def _parse_isin_page(raw: bytes) -> list[tuple[str, str]]:
    """Parse one TWSE ISIN page, return list of (symbol, name)."""
    import re
    # Try UTF-8 first, fall back to Big5
    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError:
        html = raw.decode("big5", errors="replace")
    # Each data row first <td> looks like: "2330　台積電" (U+3000 full-width space)
    results = []
    for m in re.finditer(
        r'<td[^>]*>\s*([A-Z0-9]{2,8})\u3000([^\s<][^<]*?)\s*</td>',
        html,
        re.IGNORECASE,
    ):
        sym  = m.group(1).strip().upper()
        name = m.group(2).strip()
        if sym and name:
            results.append((sym, name))
    return results


def _build_tw_stock_table() -> dict:
    """Fetch all 4 ISIN pages, build lookup table, persist to disk."""
    global _tw_table
    by_symbol: dict = {}
    by_name:   dict = {}

    for url, market in _ISIN_SOURCES:
        try:
            r = http_requests.get(url, headers=_ISIN_HEADERS, timeout=30, verify=False)
            pairs = _parse_isin_page(r.content)
            for sym, name in pairs:
                if sym not in by_symbol:
                    by_symbol[sym] = {"name": name, "market": market}
                if name not in by_name:
                    by_name[name] = sym
            logger.info(f"[tw-table] {url.split('=')[-1]} ({market}) → {len(pairs)} rows")
        except Exception as e:
            logger.error(f"[tw-table] fetch failed {url}: {e}")

    updated = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    table = {
        "by_symbol": by_symbol,
        "by_name":   by_name,
        "updated":   updated,
        "count":     len(by_symbol),
    }
    save_json(TW_TABLE_FILE, table)
    _tw_table = table
    logger.info(f"[tw-table] done — {len(by_symbol)} symbols, saved to {TW_TABLE_FILE}")
    return table


def _load_tw_table():
    """Load stock table from disk; if missing, build it now."""
    global _tw_table
    if TW_TABLE_FILE.exists():
        try:
            data = load_json(TW_TABLE_FILE, {})
            if data.get("by_symbol"):
                _tw_table = data
                logger.info(
                    f"[tw-table] loaded {data.get('count', len(data['by_symbol']))} symbols "
                    f"(updated: {data.get('updated')})"
                )
                return
        except Exception as e:
            logger.warning(f"[tw-table] cache load failed: {e}")
    logger.info("[tw-table] no cache — building initial table (this may take ~30 s)…")
    _build_tw_stock_table()


# Load on startup; auto-rebuild if emg data is absent (table predates emg support)
_load_tw_table()
if not any(v.get("market") == "emg" for v in _tw_table.get("by_symbol", {}).values()):
    import threading as _threading
    logger.info("[tw-table] emg data missing — triggering background rebuild now")
    _threading.Thread(target=_build_tw_stock_table, daemon=True).start()


def _tw_price_for_symbol(symbol: str) -> tuple[str, float | None]:
    """Fetch name + price for a TW stock symbol via TWSE mis API, with yfinance fallback."""
    for ex in ["tse", "otc"]:
        try:
            url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex}_{symbol.lower()}.tw"
            r = http_requests.get(url, timeout=5, verify=False)
            items = r.json().get("msgArray", [])
            if items:
                item = items[0]
                name = item.get("n", "")
                price = None
                for raw in [item.get("z", "-"), (item.get("b") or "").split("_")[0], item.get("y", "")]:
                    try:
                        v = float(raw)
                        if v > 0:
                            price = v
                            break
                    except Exception:
                        pass
                if name:
                    return name, price
        except Exception:
            pass

    # yfinance fallback — handles 6-char ETFs like 00988A not in MIS
    for suffix in [".TW", ".TWO"]:
        try:
            fi = yf.Ticker(f"{symbol}{suffix}").fast_info
            price = round(float(fi.last_price), 2) if getattr(fi, "last_price", None) else None
            if price:
                return "", price  # name unknown via yf, return empty string
        except Exception:
            pass
    return "", None



@app.get("/api/stock-lookup")
def stock_lookup(symbol: str = "", name: str = "", market: str = "tw"):
    symbol = symbol.strip().upper()
    name   = name.strip()

    if market == "tw":
        # ── symbol → name + price ─────────────────────────────────────────
        if symbol:
            # Name from in-memory table (instant); price from live MIS API
            entry = _tw_table.get("by_symbol", {}).get(symbol, {})
            table_name = entry.get("name", "")
            mis_name, price = _tw_price_for_symbol(symbol)
            return {"symbol": symbol, "name": table_name or mis_name, "price": price}

        # ── name → symbol + price ─────────────────────────────────────────
        if name:
            # 1. In-memory table lookup (instant)
            sym = _tw_table.get("by_name", {}).get(name, "")
            # 2. Fallback: search portfolio
            if not sym:
                portfolio = load_json(CONFIG_FILE, {"assets": [], "liabilities": [], "investments": []})
                for g in portfolio.get("investments", []):
                    if g.get("group") != "股票":
                        continue
                    for item in g.get("items", []):
                        if item.get("name") == name:
                            sym = item.get("symbol", "")
                            break
                    if sym:
                        break
            if sym:
                _, price = _tw_price_for_symbol(sym)
                return {"symbol": sym, "name": name, "price": price}
            return {"symbol": "", "name": name, "price": None}

    elif market == "us":
        if symbol:
            try:
                ticker = yf.Ticker(symbol)
                fi = ticker.fast_info
                price = round(float(fi.last_price), 4) if getattr(fi, "last_price", None) else None
                try:
                    info = ticker.info
                    us_name = info.get("shortName") or info.get("longName") or symbol
                except Exception:
                    us_name = symbol
                return {"symbol": symbol, "name": us_name, "price": price}
            except Exception:
                return {"symbol": symbol, "name": "", "price": None}

    return {}


@app.get("/api/indices")
def get_indices():
    return fetch_indices()


@app.post("/api/snapshot")
async def save_snapshot(request: Request):
    body = await request.json()
    history = load_json(HISTORY_FILE, {})
    date_key = body.get("date") or datetime.now().strftime("%Y-%m-%d")
    history[date_key] = {k: v for k, v in body.items() if k != "date"}
    save_json(HISTORY_FILE, history)
    return {"ok": True, "date": date_key}


@app.get("/api/history")
def get_history():
    return load_json(HISTORY_FILE, {})


@app.get("/api/manual-history")
def get_manual_history():
    return load_json(MANUAL_HISTORY_FILE, [])


@app.post("/api/manual-history")
async def add_manual_history(request: Request):
    body = await request.json()
    history = load_json(MANUAL_HISTORY_FILE, [])
    date = body.get("date")
    if not date:
        return {"error": "date required"}
    history = [h for h in history if h.get("date") != date]
    history.append(body)
    history.sort(key=lambda x: x.get("date", ""))
    save_json(MANUAL_HISTORY_FILE, history)
    return {"ok": True}


@app.delete("/api/manual-history/{date}")
def delete_manual_history(date: str):
    history = load_json(MANUAL_HISTORY_FILE, [])
    history = [h for h in history if h.get("date") != date]
    save_json(MANUAL_HISTORY_FILE, history)
    return {"ok": True}


@app.get("/api/market-history")
def get_market_history(start: str = "", end: str = "", indices: str = ""):
    """Fetch historical index closing prices from yfinance."""
    if not start or not indices:
        return {}
    index_map = {
        "TAIEX": "^TWII",
        "OTC": "^TWOII",
        "DJI": "^DJI",
        "NASDAQ": "^IXIC",
        "SOX": "^SOX",
    }
    wanted = [i.strip() for i in indices.split(",") if i.strip() in index_map]
    if not wanted:
        return {}

    try:
        tickers = [index_map[i] for i in wanted]
        end_date = end or datetime.now().strftime("%Y-%m-%d")
        df = yf.download(
            tickers, start=start, end=end_date,
            auto_adjust=True, progress=False, group_by="ticker",
        )
        if df is None or df.empty:
            return {}

        closes = {}
        if len(tickers) == 1:
            t = tickers[0]
            name = wanted[0]
            if "Close" in df.columns:
                series = df["Close"]
            else:
                series = df[(t, "Close")]
            closes[name] = {str(idx.date()): round(float(v), 2)
                            for idx, v in series.dropna().items()}
        else:
            for name, t in zip(wanted, tickers):
                try:
                    series = df[(t, "Close")]
                    closes[name] = {str(idx.date()): round(float(v), 2)
                                    for idx, v in series.dropna().items()}
                except Exception:
                    closes[name] = {}
        return closes
    except Exception as e:
        return {"error": str(e)}


# ── Auto snapshot (scheduled) ────────────────────────────────────────────────
def compute_and_save_snapshot() -> dict:
    """
    Server-side equivalent of JS calcTotals() + saveSnapshot().
    Fetches live prices, computes totals, writes to history.json.
    """
    portfolio = load_json(CONFIG_FILE, {"assets": [], "liabilities": [], "investments": []})

    # Exchange rates
    idx = fetch_indices()
    usd_twd = idx.get("usd_twd") or 31.77
    jpy_twd = idx.get("jpy_twd") or 0.21

    def to_twd(amount: float, currency: str) -> float:
        if currency == "USD": return amount * usd_twd
        if currency == "JPY": return amount * jpy_twd
        return amount

    # Collect tickers to refresh
    stock_keys, cb_syms, us_keys = [], [], []
    for g in portfolio.get("investments", []):
        grp = g.get("group", "")
        for item in g.get("items", []):
            sym = (item.get("symbol") or "").strip()
            if not sym:
                continue
            if grp == "美國股市":
                us_keys.append(sym)
            elif grp == "可轉債":
                cb_syms.append(sym)
            elif grp == "股票":
                stock_keys.append(sym + ".TW")

    tw_prices = fetch_prices(stock_keys) if stock_keys else {}
    us_prices = fetch_prices(us_keys)    if us_keys    else {}
    cb_data   = fetch_cb_prices(cb_syms) if cb_syms    else {}

    total_assets = 0.0
    group_totals: dict = {}

    # Assets (cash, real estate, etc.)
    for g in portfolio.get("assets", []):
        gs = sum(to_twd(float(it.get("amount") or 0), it.get("currency", "TWD"))
                 for it in g.get("items", []))
        group_totals[g["group"]] = round(gs)
        total_assets += gs

    # Investments
    for g in portfolio.get("investments", []):
        grp = g.get("group", "")
        is_cb = grp == "可轉債"
        is_us = grp == "美國股市"
        gs = 0.0
        for item in g.get("items", []):
            sym    = (item.get("symbol") or "").strip()
            cost   = float(item.get("cost")        or 0)
            shares = float(item.get("shares")      or 0)
            entry  = float(item.get("entry_price") or 0)
            # Resolve live price, fall back to stored current_price
            if is_us:
                price = float((us_prices.get(sym) or {}).get("price") or item.get("current_price") or 0)
            elif is_cb:
                price = float((cb_data.get(sym)   or {}).get("price") or item.get("current_price") or 0)
            else:
                price = float((tw_prices.get(sym + ".TW") or {}).get("price") or item.get("current_price") or 0)

            mv = (cost + (price - entry) * shares) if is_cb else (shares * price)
            gs += mv * usd_twd if is_us else mv

        group_totals[grp] = round(gs)
        total_assets += gs

    # Liabilities
    total_debts = sum(
        to_twd(float(it.get("amount") or 0), it.get("currency", "TWD"))
        for g in portfolio.get("liabilities", [])
        for it in g.get("items", [])
    )

    net_worth = total_assets - total_debts
    snapshot = {
        "net_worth":        round(net_worth),
        "total_assets":     round(total_assets),
        "total_liabilities": round(total_debts),
        "asset_groups":     group_totals,
    }

    date_key = datetime.now().strftime("%Y-%m-%d")
    history = load_json(HISTORY_FILE, {})
    history[date_key] = snapshot
    save_json(HISTORY_FILE, history)
    logger.info(f"[auto-snapshot] {date_key} saved — net_worth={net_worth:,.0f}")
    return {"date": date_key, **snapshot}


def _run_daily_snapshot():
    try:
        compute_and_save_snapshot()
    except Exception as e:
        logger.error(f"[auto-snapshot] failed: {e}")


# Scheduler: fire every day at 15:00 Taiwan time (UTC+8)
_scheduler = BackgroundScheduler(timezone="Asia/Taipei")
_scheduler.add_job(
    _run_daily_snapshot,
    CronTrigger(hour=15, minute=0, timezone="Asia/Taipei"),
    id="daily_snapshot",
    replace_existing=True,
)
# Rebuild TW stock table every Sunday at 15:00 Taiwan time
_scheduler.add_job(
    _build_tw_stock_table,
    CronTrigger(day_of_week="sun", hour=15, minute=0, timezone="Asia/Taipei"),
    id="tw_table_rebuild",
    replace_existing=True,
)
_scheduler.start()
logger.info("[scheduler] daily auto-snapshot @ 15:00 | TW stock table rebuild @ Sun 15:00")


@app.get("/api/auto-snapshot/run")
def trigger_auto_snapshot():
    """Manually trigger the auto-snapshot (for testing)."""
    try:
        result = compute_and_save_snapshot()
        return {"ok": True, **result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/auto-snapshot/status")
def auto_snapshot_status():
    job = _scheduler.get_job("daily_snapshot")
    if not job:
        return {"scheduled": False}
    return {
        "scheduled": True,
        "next_run": str(job.next_run_time),
        "timezone": "Asia/Taipei",
        "trigger": "每日 15:00",
    }


@app.get("/api/cb-suspension/status")
def cb_suspension_status():
    """Return currently suspended CBs with date ranges."""
    suspended = load_cb_suspensions()  # {code: "start - end"}
    return {
        "count": len(suspended),
        "suspended": suspended,  # dict so frontend gets date ranges too
        "cache_age_s": round(time.time() - _cb_suspension_cache["ts"]),
    }


@app.get("/api/cb-suspension/reload")
def cb_suspension_reload():
    """Force clear suspension cache and reload."""
    _cb_suspension_cache["ts"] = 0
    suspended = load_cb_suspensions()
    return {"ok": True, "count": len(suspended), "suspended": suspended}


@app.get("/api/stock-table/status")
def stock_table_status():
    """Return metadata about the in-memory TW stock table."""
    job = _scheduler.get_job("tw_table_rebuild")
    return {
        "count":      _tw_table.get("count", len(_tw_table.get("by_symbol", {}))),
        "updated":    _tw_table.get("updated"),
        "next_rebuild": str(job.next_run_time) if job else None,
        "trigger":    "每週日 15:00",
        "file":       str(TW_TABLE_FILE),
    }


@app.get("/api/stock-table/rebuild")
def stock_table_rebuild():
    """Manually trigger a full rebuild of the TW stock table."""
    import threading
    threading.Thread(target=_build_tw_stock_table, daemon=True).start()
    return {"ok": True, "message": "Rebuild started in background"}


@app.get("/api/stock-table/lookup")
def stock_table_lookup(q: str = ""):
    """Quick fuzzy search in the table — returns up to 10 matches by symbol or name prefix."""
    q = q.strip().upper()
    if not q:
        return []
    results = []
    by_symbol = _tw_table.get("by_symbol", {})
    for sym, entry in by_symbol.items():
        name = entry.get("name", "")
        if sym.startswith(q) or name.upper().startswith(q) or q in name.upper():
            results.append({"symbol": sym, "name": name, "market": entry.get("market", "")})
            if len(results) >= 10:
                break
    return results


@app.get("/api/important-info")
def get_important_info(force: bool = False):
    """Return important macro/market info from various sources."""
    try:
        return scrape_important_info(force)
    except Exception as e:
        logger.error(f"[important-info] failed: {e}")
        return {"error": str(e)}


_cb_listed_cache: dict = {"date": "", "data": None}
CB_LISTED_URL = "https://cbas16889.pscnet.com.tw/api/MiDownloadExcel/GetExcel_RecentlyCB"

@app.get("/api/cb-listed")
def get_cb_listed():
    """Return recent listed CBs from cbas pscnet Excel. Cached per calendar day."""
    global _cb_listed_cache
    import io, pandas as pd
    from datetime import date

    today = date.today().isoformat()
    if _cb_listed_cache["data"] is not None and _cb_listed_cache["date"] == today:
        return _cb_listed_cache["data"]

    try:
        resp = http_requests.get(CB_LISTED_URL, verify=False, timeout=15)
        resp.raise_for_status()
        df = pd.read_excel(io.BytesIO(resp.content))

        rows = []
        for _, r in df.iterrows():
            # 金額
            try:
                amt = float(r.get('發行量(億)', 0))
                amt_str = f"{int(amt)}E" if amt == int(amt) else f"{amt}E"
            except Exception:
                amt_str = str(r.get('發行量(億)', ''))

            # 年期：5年 → 5y
            years = str(r.get('年期', '')).replace('年', 'y')

            # 轉換價
            try:
                cp = r.get('轉換價', '')
                conv_price = str(int(float(cp))) if float(cp) == int(float(cp)) else str(cp)
            except Exception:
                conv_price = str(r.get('轉換價', ''))

            # 掛牌日：2026/04/15 → 115/04/15
            listing_raw = str(r.get('掛牌日', ''))
            try:
                parts = listing_raw.split('/')
                listing = f"{int(parts[0])-1911}/{parts[1]}/{parts[2]}" if len(parts) == 3 else listing_raw
            except Exception:
                listing = listing_raw

            remarks = str(r.get('備註', '') or '').strip()
            if remarks == 'nan':
                remarks = ''

            rows.append({
                "cb_code":    str(r.get('CB代號', '')).strip(),
                "name":       str(r.get('CB名稱', '')).strip(),
                "tcri":       str(r.get('TCRI/擔保', '')).strip(),
                "amount":     amt_str,
                "years":      years,
                "conv_price": conv_price,
                "listing":    listing,
                "remarks":    remarks,
            })

        td = date.today()
        roc_date = f"{td.year - 1911}.{td.month}.{td.day}"
        result = {"items": rows, "total": len(rows), "data_date": roc_date}
        _cb_listed_cache = {"date": today, "data": result}
        return result
    except Exception as e:
        logger.error(f"[cb-listed] {e}")
        return {"items": [], "total": 0, "error": str(e)}


_fsc_cache: dict = {"date": "", "data": None}
FSC_SFB_INDEX = "https://www.sfb.gov.tw/ch/home.jsp?id=1016&parentpath=0,6,52"
_FSC_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

def _fetch_fsc_excel_url() -> tuple[str, str]:
    """Scrape sfb.gov.tw for the latest FSC Excel URL and its update date.
    Returns (url, date_str) where date_str is like '115.4.22'."""
    import re as _re
    try:
        r = http_requests.get(FSC_SFB_INDEX, headers=_FSC_UA, verify=False, timeout=10)
        # Find href containing the xlsx file (filename starts with 115...)
        href_m = _re.search(r'href="([^"]*115\d+[^"]*\.xlsx)"', r.text, _re.IGNORECASE)
        date_m = _re.search(r'(\d{3}\.\d{1,2}\.\d{1,2})</td>[^<]{0,100}<td[^>]*>[^<]*<a[^>]*115\d', r.text)
        url = href_m.group(1) if href_m else ""
        if url and not url.startswith("http"):
            url = "https://www.sfb.gov.tw" + url
        date_str = date_m.group(1) if date_m else ""
        return url, date_str
    except Exception as e:
        logger.warning(f"[fsc] sfb scrape failed: {e}")
        return "", ""

def _roc_date_to_str(val) -> str:
    """Convert ROC date int like 1150323 → '115/03/23'."""
    try:
        s = str(int(val))
        if len(s) == 7:
            return f"{s[:3]}/{s[3:5]}/{s[5:7]}"
    except Exception:
        pass
    return ""

def _amount_to_e(amount_raw, currency_raw) -> str:
    """Format amount as xE. Default TWD (no label); USD shown explicitly."""
    try:
        yi = float(amount_raw) / 1e8
        yi_str = f"{yi:.2f}".rstrip('0').rstrip('.')
        currency = str(currency_raw or '').strip()
        if currency == '美元':
            return f"{yi_str}E USD"
        return f"{yi_str}E"
    except Exception:
        return str(amount_raw)

def _cb_subtype(cat: str) -> str:
    """Extract CB subtype tag: 有擔保 / 無擔保 / 海外."""
    if '海外' in cat:
        return '海外'
    if '有擔保' in cat:
        return '有擔保'
    if '無擔保' in cat:
        return '無擔保'
    return ''

@app.get("/api/fsc-offerings")
def get_fsc_offerings():
    """Return approved 現金增資 / 轉換公司債 from FSC annual Excel. Cached per calendar day."""
    global _fsc_cache
    import io, pandas as pd
    from datetime import date

    today = date.today().isoformat()
    cached = _fsc_cache["data"]
    if cached is not None and _fsc_cache["date"] == today and cached.get("excel_date"):
        return cached

    try:
        excel_url, excel_date = _fetch_fsc_excel_url()
        if not excel_url:
            raise ValueError("Could not resolve FSC Excel URL from sfb.gov.tw")
        logger.info(f"[fsc] fetching {excel_url} (date: {excel_date})")
        resp = http_requests.get(excel_url, verify=False, timeout=30,
                                  headers=_FSC_UA)
        resp.raise_for_status()
        df = pd.read_excel(io.BytesIO(resp.content), header=2)

        # Normalise column names
        df.columns = [str(c).strip().replace('\u3000', '').replace('\n', '') for c in df.columns]
        amt_col = next((c for c in df.columns if '金' in c and '額' in c), None)

        # Filter: 生效日期 has a value AND 案件類別 matches target
        df = df[df['生效日期'].notna()].copy()
        df = df[df['案件類別'].str.contains('現金增資|轉換公司債', na=False)].copy()

        rows = []
        for _, r in df.iterrows():
            cat = str(r.get('案件類別', ''))
            kind = '現金增資' if '現金增資' in cat else '轉換公司債'

            amount_raw = r.get(amt_col) if amt_col else None
            amount_str = _amount_to_e(amount_raw, r.get('幣別', ''))

            price_raw = r.get('發行價格', None)
            try:
                price = None if (price_raw is None or str(price_raw) == 'nan') else float(price_raw)
                price_str = str(int(price)) if price and price == int(price) else (f"{price}" if price else '')
            except Exception:
                price_str = ''

            eff_str = _roc_date_to_str(r.get('生效日期'))

            rows.append({
                "code":     str(r.get('證券代號', '')).strip().rstrip('*'),
                "name":     str(r.get('公司名稱', '')).strip().rstrip('*'),
                "kind":     kind,
                "cb_sub":   _cb_subtype(cat) if kind == '轉換公司債' else '',
                "amount":   amount_str,
                "price":    price_str,
                "eff_date": eff_str,
                "eff_raw":  str(int(float(r['生效日期']))),
            })

        result = {"items": rows, "total": len(rows), "excel_date": excel_date}
        _fsc_cache = {"date": today, "data": result}
        return result
    except Exception as e:
        logger.error(f"[fsc-offerings] {e}")
        return {"items": [], "total": 0, "error": str(e)}


# ── Serve frontend ───────────────────────────────────────────────────────────
from fastapi import Response
from starlette.middleware.base import BaseHTTPMiddleware

class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

app.add_middleware(NoCacheMiddleware)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
def serve_index():
    return FileResponse(
        str(FRONTEND_DIR / "index.html"),
        headers={"Cache-Control": "no-store"},
    )
