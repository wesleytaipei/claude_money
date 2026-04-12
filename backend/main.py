"""HC Finance Web — FastAPI backend"""
import json
import logging
import time
from datetime import datetime
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
                    # Merge dictionaries (priority to current but keep source keys)
                    merged = {**source_data, **curr_data}
                    with open(target, "w", encoding="utf-8") as target_f:
                        json.dump(merged, target_f, ensure_ascii=False, indent=2)
                elif isinstance(source_data, list) and isinstance(curr_data, list):
                    # Merge lists (unique by 'date' if applicable)
                    dates_in_curr = {it.get("date") for it in curr_data if isinstance(it, dict)}
                    for it in source_data:
                        if isinstance(it, dict) and it.get("date") not in dates_in_curr:
                            curr_data.append(it)
                    curr_data.sort(key=lambda x: str(x.get("date", "")))
                    with open(target, "w", encoding="utf-8") as target_f:
                        json.dump(curr_data, target_f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"Error merging {f.name}: {e}")

ensure_data_seeded()

CONFIG_FILE = DATA_DIR / "alm_config.json"
HISTORY_FILE = DATA_DIR / "history.json"
MANUAL_HISTORY_FILE = DATA_DIR / "manual_history.json"

_price_cache: dict = {}
_indices_cache: dict = {"ts": 0, "data": {}}
CACHE_TTL = 300  # 5 minutes


# ── IO helpers ───────────────────────────────────────────────────────────────
def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


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
                    currency = getattr(fi, "currency", None) or "TWD"
                    entry = {
                        "price": round(float(price), 4) if price else None,
                        "currency": currency,
                        "ts": now,
                    }
                    _price_cache[t] = entry
                    result[t] = entry
                except Exception as e:
                    err = {"price": None, "currency": "N/A", "error": str(e), "ts": now}
                    _price_cache[t] = err
                    result[t] = err
        except Exception as e:
            for t in to_fetch:
                result[t] = {"price": None, "currency": "N/A", "error": str(e), "ts": now}

    return result


def fetch_indices() -> dict:
    now = time.time()
    if _indices_cache["ts"] and (now - _indices_cache["ts"]) < CACHE_TTL:
        return _indices_cache["data"]

    index_tickers = {
        "taiex": "^TWII",
        "otc": "^TWOII",
        "dji": "^DJI",
        "nasdaq": "^IXIC",
        "sox": "^SOX",
    }
    fx_tickers = {"usd_twd": "USDTWD=X", "jpy_twd": "JPYTWD=X"}

    result = {}
    all_tickers = list(index_tickers.values()) + list(fx_tickers.values())

    try:
        tkrs = yf.Tickers(" ".join(all_tickers))

        for key, sym in index_tickers.items():
            try:
                fi = tkrs.tickers[sym].fast_info
                price = float(fi.last_price or 0)
                prev = float(getattr(fi, "previous_close", None) or 0)
                change = price - prev if prev else 0
                pct = (change / prev * 100) if prev else 0
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
                cbas[code] = {
                    "name": item.get("n", ""),
                    "price": round(price, 4) if price else None,
                    "ts": now,
                }
        except Exception:
            pass

    for s in symbols:
        result[s] = cbas.get(s, {"price": None, "name": "", "ts": now})

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
    tks = [t.strip() for t in tickers.split(",") if t.strip()]
    return fetch_prices(tks)


@app.get("/api/cb-prices")
def get_cb_prices(symbols: str = ""):
    if not symbols.strip():
        return {}
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
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


@app.get("/api/stock-lookup")
def stock_lookup(symbol: str = "", market: str = "tw"):
    symbol = symbol.strip().upper()
    if not symbol:
        return {}

    if market == "tw":
        for ex in ["tse", "otc"]:
            try:
                url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex}_{symbol.lower()}.tw"
                r = http_requests.get(url, timeout=5, verify=False)
                items = r.json().get("msgArray", [])
                if items:
                    item = items[0]
                    name = item.get("n", "")
                    z = item.get("z", "-")
                    b = item.get("b", "")
                    y = item.get("y", "")
                    price = None
                    for raw in [z, b.split("_")[0] if b else "", y]:
                        try:
                            v = float(raw)
                            if v > 0:
                                price = v
                                break
                        except Exception:
                            pass
                    if name:
                        return {"symbol": symbol, "name": name, "price": price}
            except Exception:
                pass
        return {"symbol": symbol, "name": "", "price": None}

    elif market == "us":
        try:
            ticker = yf.Ticker(symbol)
            fi = ticker.fast_info
            price = round(float(fi.last_price), 4) if getattr(fi, "last_price", None) else None
            try:
                info = ticker.info
                name = info.get("shortName") or info.get("longName") or symbol
            except Exception:
                name = symbol
            return {"symbol": symbol, "name": name, "price": price}
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
_scheduler.start()
logger.info("[scheduler] daily auto-snapshot scheduled at 15:00 Asia/Taipei")


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
