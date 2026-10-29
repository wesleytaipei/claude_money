import json
import re
import time
import urllib3
import requests
from bs4 import BeautifulSoup
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path as _Path

urllib3.disable_warnings()

CACHE_TTL = 120 # 2 minutes cache
_info_cache = {"ts": 0, "data": {}}

FIRECRAWL_API_KEY = "fc-d6d780def05343a5b032c3d22e89e15d"
_margin_ratio_cache = {"ts": 0, "data": None}       # daily data — cache 6 hours
_tpex_margin_ratio_cache = {"ts": 0, "data": None, "fail_ts": 0.0}  # daily data — cache 6 hours

# ── Margin ratio history (persist prev-day values across restarts) ─────────────
_RATIO_HIST_FILE = _Path(__file__).parent / 'data' / 'margin_ratio_history.json'
_ratio_hist_dirty = False

def _load_ratio_history() -> dict:
    try:
        return json.loads(_RATIO_HIST_FILE.read_text(encoding='utf-8'))
    except Exception:
        return {}

def _save_ratio_history(hist: dict):
    global _ratio_hist_dirty
    # Keep only last 90 days
    for old in sorted(hist.keys())[:-90]:
        del hist[old]
    _RATIO_HIST_FILE.write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding='utf-8')
    _ratio_hist_dirty = True

def ratio_history_pop_dirty() -> bool:
    global _ratio_hist_dirty
    v = _ratio_hist_dirty
    _ratio_hist_dirty = False
    return v

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

def fetch_macromicro(url):
    """Fetch MacroMicro data using requests instead of Selenium for speed."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=10, verify=False)
        match = re.search(r'let chart = (\{.*?\});', r.text)
        if match:
            data = json.loads(match.group(1))
            last_rows_str = data.get("series_last_rows")
            if last_rows_str:
                last_rows = json.loads(last_rows_str)[0]
                if len(last_rows) >= 2:
                    prev = float(last_rows[-2][1])
                    curr = float(last_rows[-1][1])
                    return {"current": curr, "prev": prev}
    except Exception as e:
        print(f"Error fetching macromicro {url}: {e}")
    return {"current": None, "prev": None}

_twse_margin_cache = {"date": "", "data": None, "last_good": None, "fail_ts": 0.0}
_tpex_margin_cache_v2 = {"date": "", "data": None, "last_good": None, "fail_ts": 0.0}
_MARGIN_COOLDOWN = 180   # seconds before retrying after all attempts fail
_MARGIN_RETRIES  = 3

def _safe_float(v):
    """Parse a string that may be '-', '', or a comma-number."""
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None

def _tw_today() -> str:
    """Return today's date in Asia/Taipei timezone (UTC+8) as ISO string."""
    from datetime import datetime, timezone, timedelta
    return datetime.now(tz=timezone(timedelta(hours=8))).date().isoformat()

def fetch_twse_margin(force=False):
    # Row layout of MI_MARGN tables[0].data:
    #   [0] 融資(交易單位)   cols [4]=前日 [5]=今日  (in 張)
    #   [1] 融券(交易單位)
    #   [2] 融資金額(仟元)   cols [4]=前日 [5]=今日  ← the one we want
    today_str = _tw_today()
    c = _twse_margin_cache
    if not force and c["date"] == today_str and c["data"]:
        return c["data"]
    # Cooldown: don't hammer if all recent attempts failed
    if not force and c["fail_ts"] and time.time() - c["fail_ts"] < _MARGIN_COOLDOWN:
        return c["last_good"] or {"balance": None, "increase": None}

    last_err = None
    for attempt in range(_MARGIN_RETRIES):
        try:
            resp_json = requests.get(
                "https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json",
                headers=HEADERS, verify=False, timeout=15
            ).json()
            tables = resp_json.get("tables", [])
            if not tables:
                raise ValueError("empty tables")
            data = tables[0].get("data", [])
            if len(data) < 3:
                raise ValueError(f"only {len(data)} rows")
            row = data[2]
            if len(row) < 6:
                raise ValueError(f"short row: {row}")
            yest_val  = _safe_float(row[4])
            today_val = _safe_float(row[5])
            if today_val is None:
                raise ValueError(f"non-numeric value: {row}")
            increase = (today_val - yest_val) if yest_val is not None else 0
            result = {
                "balance":  round(today_val / 100000, 2),
                "increase": round(increase  / 100000, 2),
            }
            # Always cache valid data; mark stale if not today's date
            resp_raw = resp_json.get("date", "")
            resp_date = f"{resp_raw[:4]}-{resp_raw[4:6]}-{resp_raw[6:8]}" if len(resp_raw) == 8 else ""
            result["stale"] = (resp_date != today_str) if resp_date else False
            c["date"]      = today_str if not result["stale"] else resp_date
            c["data"]      = result if not result["stale"] else None
            c["last_good"] = result
            c["fail_ts"]   = 0.0
            print(f"[TWSE margin] ok (date={resp_date}, stale={result['stale']})")
            return result
        except Exception as e:
            last_err = e
            if attempt < _MARGIN_RETRIES - 1:
                time.sleep(1)

    print(f"[TWSE margin] all {_MARGIN_RETRIES} attempts failed: {last_err}")
    c["fail_ts"] = time.time()
    return c["last_good"] or {"balance": None, "increase": None}


_tpex_margin_cache = {"date": "", "data": None}   # kept for compat (unused below)

def fetch_tpex_margin(force=False):
    """
    Fetch TPEX total margin balance (融資餘額).
    summary[0] → lot-count units (仟張)
    summary[1] → value units (仟元)  ← this is what we want
    Cols: [0]=代號 [1]=名稱 [2]=前日餘額 [3]=買進 [4]=賣出 [5]=還款 [6]=今日餘額
    """
    import json as _json
    today_str = _tw_today()
    c = _tpex_margin_cache_v2
    if not force and c["date"] == today_str and c["data"]:
        return c["data"]
    if not force and c["fail_ts"] and time.time() - c["fail_ts"] < _MARGIN_COOLDOWN:
        return c["last_good"] or {"balance": None, "increase": None}

    url = ("https://www.tpex.org.tw/web/stock/margin_trading/margin_balance"
           "/margin_bal_result.php?l=zh-tw&o=json")
    last_err = None
    for attempt in range(_MARGIN_RETRIES):
        try:
            r = requests.get(url, headers=HEADERS, verify=False, timeout=15)
            r.raise_for_status()
            # TPEX may return cp950; try that first then fall back to utf-8
            for enc in ("cp950", "utf-8", "big5"):
                try:
                    raw = r.content.decode(enc, errors="strict")
                    break
                except Exception:
                    raw = r.text
            data = _json.loads(raw)
            tables = data.get("tables", [])
            if not tables:
                raise ValueError("empty tables")
            summary = tables[0].get("summary", [])
            if len(summary) < 2:
                raise ValueError(f"summary rows={len(summary)}")
            row = summary[1]
            if len(row) < 7:
                raise ValueError(f"short summary row: {row}")
            today_val = _safe_float(row[6])
            yest_val  = _safe_float(row[2])
            if today_val is None:
                raise ValueError(f"non-numeric: {row}")
            increase = (today_val - yest_val) if yest_val is not None else 0
            result = {
                "balance":  round(today_val / 100000, 2),
                "increase": round(increase  / 100000, 2),
            }
            resp_raw  = data.get("date", "")
            resp_date = f"{resp_raw[:4]}-{resp_raw[4:6]}-{resp_raw[6:8]}" if len(resp_raw) == 8 else ""
            result["stale"] = (resp_date != today_str) if resp_date else False
            c["date"]      = today_str if not result["stale"] else resp_date
            c["data"]      = result if not result["stale"] else None
            c["last_good"] = result
            c["fail_ts"]   = 0.0
            print(f"[TPEX margin] ok (date={resp_date}, stale={result['stale']})")
            return result
        except Exception as e:
            last_err = e
            if attempt < _MARGIN_RETRIES - 1:
                time.sleep(1)

    print(f"[TPEX margin] all {_MARGIN_RETRIES} attempts failed: {last_err}")
    c["fail_ts"] = time.time()
    return c["last_good"] or {"balance": None, "increase": None}

def fetch_yahoo_future(symbol_encoded):
    """Fetch futures from Yahoo Finance Taiwan."""
    try:
        url = f"https://tw.stock.yahoo.com/future/{symbol_encoded}"
        r = requests.get(url, headers=HEADERS, verify=False, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")

        price_el = (soup.select_one('span[class*="Fz(32px)"]')
                    or soup.select_one('[class*="Fw(b)"][class*="Fz(32px)"]'))
        change_el = (soup.select_one('span[class*="Fz(20px)"]')
                     or soup.select_one('span[class*="C($"]'))

        if not price_el:
            return {"price": "-", "change": "-", "change_pct": "-"}

        price_str = price_el.text.strip()

        # Direction from CSS class — Yahoo uses C($c-trend-down) / C($c-trend-up)
        el_class = " ".join((change_el or price_el).get("class", []))
        is_neg = "trend-down" in el_class

        # change_el contains an inner <span> arrow glyph with no text + the number
        change_text = change_el.get_text(separator="", strip=True) if change_el else "-"

        # Strip any parenthesised pct that Yahoo sometimes appends
        change_val = "-"
        change_pct = "-"
        if "(" in change_text:
            raw_val, raw_pct = change_text.split("(", 1)
            change_val = raw_val.strip()
            change_pct = raw_pct.replace(")", "").strip()
        else:
            change_val = change_text

        # Apply sign from CSS class (strip any existing sign first, then re-apply)
        try:
            price_num  = float(price_str.replace(",", ""))
            change_abs = float(str(change_val).replace(",", "").replace("+", "").replace("-", ""))
            sign       = -1 if is_neg else 1
            change_signed = sign * change_abs

            change_val = f"{'-' if is_neg else '+'}{change_abs}"

            if change_pct == "-":
                prev = price_num - change_signed
                if prev > 0:
                    pct_calc = round(abs(change_signed) / prev * 100, 2)
                    change_pct = f"{'-' if is_neg else '+'}{pct_calc}%"
            else:
                # Ensure sign on existing pct string
                pct_clean = change_pct.replace("+", "").replace("-", "").replace("%", "")
                change_pct = f"{'-' if is_neg else '+'}{pct_clean}%"
        except Exception:
            pass

        return {"price": price_str, "change": change_val, "change_pct": change_pct}
    except Exception as e:
        print(f"Error fetching Yahoo future {symbol_encoded}: {e}")
    return {"price": "-", "change": "-", "change_pct": "-"}

def fetch_cnyes_twncon():
    """Fetch 富台指 (TWNCON) from Cnyes SSR page - quote JSON embedded in HTML."""
    try:
        url = "https://invest.cnyes.com/futures/GF/TWNCON"
        r = requests.get(url, headers=HEADERS, timeout=10, verify=False)
        match = re.search(r'"quote":\{"0":"GF:TWNCON:FUTURES"([^}]+)\}', r.text)
        if match:
            # Parse individual fields
            def _field(key, text):
                m = re.search(rf'"{key}":([\d.+-]+)', text)
                return float(m.group(1)) if m else None
            body = match.group(1)
            price = _field(6, body)
            change = _field(11, body)
            prev  = _field(19, body)
            pct   = _field(56, body)
            if price is not None:
                change = change or 0.0
                pct    = pct or 0.0
                return {
                    "price": str(round(price, 1)),
                    "change": f"+{round(change, 1)}" if change > 0 else str(round(change, 1)),
                    "change_pct": f"{round(pct, 2)}%"
                }
    except Exception as e:
        print(f"Error fetching TWNCON: {e}")
    # Cnyes' "GF" (global futures) category has been returning 404/500 site-wide —
    # fall back to the same underlying instrument (SGX FTSE Taiwan Index Futures).
    # SGX's own API has the T+1 night session; Yahoo's TWN-*.SI is day-session only.
    return fetch_sgx_twn() or fetch_stwn_robust()

def fetch_taiwan_vix():
    """Fetch 臺指選擇權波動率指數 (TAIWANVIX / 台指VIX) from TAIFEX MIS realtime quote.
    Note: mis.taifex.com.tw is likely IP-blocked on Railway — relayed via Gist."""
    try:
        r = requests.post(
            "https://mis.taifex.com.tw/futures/api/getQuoteDetail",
            json={"SymbolID": ["TAIWANVIX"]},
            headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json",
                     "Origin": "https://mis.taifex.com.tw",
                     "Referer": "https://mis.taifex.com.tw/futures/"},
            timeout=10, verify=False)
        q = r.json().get("RtData", {}).get("QuoteList", [{}])[0]
        last = _safe_float(q.get("CLastPrice"))
        ref  = _safe_float(q.get("CRefPrice"))
        if last is not None and last > 0:
            change = round(last - ref, 2) if ref else 0.0
            pct    = round(change / ref * 100, 2) if ref else 0.0
            return {
                "price": f"{last:.2f}",
                "change": f"+{change}" if change > 0 else str(change),
                "change_pct": f"{pct}%",
            }
    except Exception as e:
        print(f"Error fetching TAIWANVIX: {e}")
    return {"price": "-", "change": "-", "change_pct": "-"}

_FUTURES_MONTH_CODES = "FGHJKMNQUVXZ"

def _futures_month_symbol(dt):
    return f"{_FUTURES_MONTH_CODES[dt.month - 1]}{dt.year % 100:02d}"

_SGX_TWN_URL = "https://api.sgx.com/derivatives/v1.0/contract-code/TWN"
_SGX_TWN_OUTRIGHT = re.compile(r"^TWN[FGHJKMNQUVXZ]\d{2}$")

def _sgt():
    from datetime import timezone, timedelta
    return timezone(timedelta(hours=8))

_sgx_twn_cache = {"ts": 0.0, "data": None}   # the SGX payload is ~3.5MB; share it between callers

def _sgx_twn_detail():
    """SGX FTSE Taiwan Index Futures (富台指) front month from SGX's public derivatives API.

    Each contract comes back as two rows: current-trading-session "0" = T session
    (08:45-13:45 SGT) and "1" = T+1 night session (14:00-05:15 SGT). Yahoo's TWN-*.SI
    only carries the T session, so overnight it sits frozen at the 13:50 close.
    Returns {price, session, asof, base_date, day_settle, prev_settle} or None."""
    from datetime import datetime
    c = _sgx_twn_cache
    if c["data"] and time.time() - c["ts"] < 30:
        return c["data"]
    try:
        r = requests.get(_SGX_TWN_URL, timeout=15, verify=False,
                         headers={**HEADERS, "Origin": "https://www.sgx.com", "Referer": "https://www.sgx.com/"})
        by_sym = {}
        for row in r.json().get("data") or []:
            sym = row.get("symbol") or ""
            if _SGX_TWN_OUTRIGHT.match(sym):
                by_sym.setdefault(sym, {})[str(row.get("current-trading-session"))] = row
        # front month = the outright with the most T-session volume
        front_sym = max(by_sym, key=lambda k: (by_sym[k].get("0") or {}).get("total-volume") or 0, default=None)
        if not front_sym:
            return None
        front = by_sym[front_sym]
        day, night = front.get("0") or {}, front.get("1") or {}

        now = datetime.now(_sgt())
        hm = now.hour * 60 + now.minute
        in_day_session = 8 * 60 + 45 <= hm < 14 * 60
        cur = day if (in_day_session or not night.get("last-traded-price-abs")) else night
        price = cur.get("last-traded-price-abs")
        if not price or float(price) <= 100:   # sanity check — trades ~3000-4000 points
            return None

        asof = None
        try:
            asof = datetime.strptime(str(cur.get("last-update-time"))[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=_sgt())
        except Exception:
            pass
        detail = {
            "symbol": front_sym,
            "price": float(price),
            "session": "night" if cur is night else "day",
            "asof": asof,
            "base_date": str(day.get("base-date") or ""),
            "day_settle": _safe_float(day.get("daily-settlement-price-abs")),
            "prev_settle": _safe_float(day.get("preliminary-settlement-price-abs")),
        }
        c["ts"], c["data"] = time.time(), detail
        return detail
    except Exception as e:
        print(f"SGX TWN API error: {e}")
        return None


_sgx_settle_cache = {}   # symbol -> (ts, {base_date: settlement})

def _sgx_settle_on(symbol, base_date):
    """SGX daily settlement of `symbol` on the SGX trading date `base_date` (YYYYMMDD), from the
    history endpoint. The live rows only carry today's and the previous settlement, which is not
    enough once SGX has traded two or more days while Taiwan was shut."""
    ts, hist = _sgx_settle_cache.get(symbol, (0, None))
    if hist is None or time.time() - ts > 3600:
        try:
            r = requests.get(f"https://api.sgx.com/derivatives/v1.0/history/symbol/{symbol}",
                             params={"days": "1m", "category": "futures"}, timeout=15, verify=False,
                             headers={**HEADERS, "Origin": "https://www.sgx.com", "Referer": "https://www.sgx.com/"})
            hist = {str(x.get("base-date")): _safe_float(x.get("daily-settlement-price-abs"))
                    for x in r.json().get("data") or [] if x.get("base-date")}
            _sgx_settle_cache[symbol] = (time.time(), hist)
        except Exception as e:
            print(f"SGX settle history error: {e}")
            return None
    return hist.get(str(base_date))


def fetch_sgx_twn():
    """富台指 card value. Change is vs the prior settlement during the day, and vs the
    day's settlement at night. Returns None on any failure so the caller can fall back."""
    d = _sgx_twn_detail()
    if not d:
        return None
    ref = d["day_settle"] if d["session"] == "night" else d["prev_settle"]
    if not ref:
        return None
    change = round(d["price"] - ref, 2)
    pct = round(change / ref * 100, 2)
    return {
        "price": str(round(d["price"], 1)),
        "change": f"+{change}" if change > 0 else str(change),
        "change_pct": f"{pct}%",
    }


_TAIFEX_MIS_QUOTE_LIST = "https://mis.taifex.com.tw/futures/api/getQuoteList"
_TXF_CONTRACT_RE = re.compile(r"^(TXF[A-L]\d)-([FM])$")

def _taifex_txf_rows(market_type):
    """market_type "0" = 日盤, "1" = 夜盤 (盤後)."""
    body = {"MarketType": market_type, "SymbolType": "F", "KindID": "1", "CID": "TXF",
            "ExpireMonth": "", "RowSize": "全部", "PageNo": "", "SortColumn": "", "AscDesc": "A"}
    r = requests.post(_TAIFEX_MIS_QUOTE_LIST, json=body, timeout=10, verify=False,
                      headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json",
                               "Origin": "https://mis.taifex.com.tw", "Referer": "https://mis.taifex.com.tw/futures/"})
    return r.json().get("RtData", {}).get("QuoteList", []) or []

def fetch_txf_quote():
    """TAIFEX MIS: TAIEX spot (+its trade date) and the latest front-month 台指期 print, whichever
    of day/night session traded last. Night rows keep the trading-date in CDate, so a CTime before
    08:00 belongs to the next calendar day. Returns None on failure."""
    from datetime import datetime, timedelta
    try:
        day_rows, night_rows = _taifex_txf_rows("0"), _taifex_txf_rows("1")
        spot_row = next((q for q in day_rows if q.get("SymbolID") == "TXF-S"), {})
        spot = _safe_float(spot_row.get("CLastPrice"))
        if not spot:
            return None

        front, vol_max = None, -1.0
        for q in day_rows:
            m = _TXF_CONTRACT_RE.match(q.get("SymbolID") or "")
            vol = _safe_float(q.get("CTotalVolume")) or 0.0
            if m and vol > vol_max:
                front, vol_max = m.group(1), vol

        cands = []
        for rows, suffix, is_night in ((day_rows, "F", False), (night_rows, "M", True)):
            q = next((x for x in rows if x.get("SymbolID") == f"{front}-{suffix}"), None) if front else None
            if not q:
                continue
            last, ref = _safe_float(q.get("CLastPrice")), _safe_float(q.get("CRefPrice"))
            if not last or not q.get("CDate") or not q.get("CTime"):
                continue
            ts = datetime.strptime(q["CDate"] + q["CTime"], "%Y%m%d%H%M%S").replace(tzinfo=_sgt())
            if is_night and ts.hour < 8:
                ts += timedelta(days=1)
            cands.append({"price": last, "ref": ref, "night": is_night, "asof": ts})
        return {"spot": spot, "spot_date": str(spot_row.get("CDate") or ""),
                "quote": max(cands, key=lambda c: c["asof"]) if cands else None}
    except Exception as e:
        print(f"TAIFEX TXF error: {e}")
        return None


_TXF_FRESH_MIN = 90   # a 台指期 print older than this is not used as the primary estimate

# 推估開盤參數。w_ftse = FTSE Taiwan RIC Capped Index (富台指 underlying) caps any constituent at 20%
# per quarterly rebalance; w_taiex is recomputed daily from TWSE data, the value here is only a fallback.
# alpha / beta are consultant-suggested assumptions (ADR pass-through to 2330, NQ sensitivity) — not backtested.
_EST_W_FTSE = 0.20
_EST_W_TAIEX_FALLBACK = 0.35
_EST_ALPHA = 0.80
_EST_BETA = 1.20

_W_TAIEX_FILE = _Path(__file__).parent / "data" / "taiex_tsmc_weight.json"

def _taiex_tsmc_weight():
    """2330 share of TAIEX (full market-cap weighted) = 2330 cap / total listed cap, from TWSE open
    data (issued shares x latest close). Cached per Taipei day; falls back to the last good value."""
    today = _tw_today()
    cached = {}
    try:
        cached = json.loads(_W_TAIEX_FILE.read_text(encoding="utf-8"))
        if cached.get("date") == today and cached.get("w"):
            return cached["w"]
    except Exception:
        pass
    try:
        hdr = {"User-Agent": "Mozilla/5.0"}
        px = {r["Code"]: r["ClosingPrice"] for r in requests.get(
            "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", headers=hdr, timeout=30, verify=False).json()}
        co = requests.get("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", headers=hdr, timeout=30, verify=False).json()
        kc = next(k for k in co[0] if "公司代號" in k)
        ks = next(k for k in co[0] if "已發行普通股" in k)
        total = tsmc = 0.0
        for c in co:
            price, shares = _safe_float(px.get(c[kc])), _safe_float(c[ks])
            if price and shares:
                total += price * shares
                if c[kc] == "2330":
                    tsmc = price * shares
        w = tsmc / total if total else 0
        if 0.2 < w < 0.6:
            _W_TAIEX_FILE.parent.mkdir(exist_ok=True)
            _W_TAIEX_FILE.write_text(json.dumps({"date": today, "w": round(w, 4)}), encoding="utf-8")
            return round(w, 4)
    except Exception as e:
        print(f"TAIEX TSMC weight error: {e}")
    return cached.get("w") or _EST_W_TAIEX_FALLBACK


def _fx_change_pct(since):
    """USD/TWD % change from the bar at/before `since` (aware datetime) to the latest bar.
    Positive = USD up / TWD weaker. None on failure."""
    try:
        h = yf.Ticker("TWD=X").history(period="1mo", interval="15m")["Close"].dropna()
        if h.empty:
            return None
        before = h[h.index <= since]
        if before.empty:
            return None
        return (h.iloc[-1] / before.iloc[-1] - 1) * 100
    except Exception as e:
        print(f"USD/TWD error: {e}")
        return None


def _nq_after_close(now):
    """E-mini Nasdaq-100 move since the last US cash close (16:00 New York) — fills the gap while
    the TSM ADR is shut. Returns (pct, asof) or (0.0, None) while the US cash session is open
    (the ADR itself is live then), or None on failure."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo
    try:
        ny = now.astimezone(ZoneInfo("America/New_York"))
        if ny.weekday() < 5 and (9, 30) <= (ny.hour, ny.minute) < (16, 0):
            return 0.0, None
        close = ny.replace(hour=16, minute=0, second=0, microsecond=0)
        if ny < close or ny.weekday() >= 5:
            close -= timedelta(days=1)
        while close.weekday() >= 5:
            close -= timedelta(days=1)
        h = yf.Ticker("NQ=F").history(period="5d", interval="5m", prepost=True)["Close"].dropna()
        before = h[h.index <= close]
        if before.empty or h.index[-1] <= close:
            return None
        return (h.iloc[-1] / before.iloc[-1] - 1) * 100, h.index[-1].to_pydatetime().astimezone(_sgt())
    except Exception as e:
        print(f"NQ after-close error: {e}")
        return None


def estimate_taiex_open(tsm_change_pct=None):
    """推估加權開盤。Two independent estimates, each stamped with its data time:
      台指期夜盤逆推 — last night-session print minus the (day settlement - spot) basis. TWD-priced and
                       the same constituents as TAIEX, so no weight / FX correction is needed.
      富台指權重修正 — 富台指 move since TAIEX's last close, converted to TWD with USD/TWD, then
                       re-weighted for TSMC (w_taiex vs w_ftse) using a TSMC proxy:
                         R_tsmc = alpha*(TSM ADR + FX) + beta*NQ move since the US close.
                       The SGX reference settlement is the one in force at TAIEX's last close, so it
                       stays right when Taiwan is shut but SGX trades.
    Primary = 台指期 while it is fresh (roughly until 05:00 + 90min), otherwise 富台指 — whose data time
    is advanced by the NQ print, so it stays usable through the 05:00-08:45 gap."""
    from datetime import datetime
    txf = fetch_txf_quote()
    if not txf:
        return None
    spot = txf["spot"]
    now = datetime.now(_sgt())
    fresh_s = _TXF_FRESH_MIN * 60
    methods = []

    q = txf["quote"]
    if q and q["night"] and q["ref"]:
        methods.append({"name": "台指期夜盤逆推", "value": q["price"] - (q["ref"] - spot), "asof": q["asof"],
                        "fresh": (now - q["asof"]).total_seconds() <= fresh_s, "detail": "台幣計價、成分一致，免權重與匯率修正"})

    sgx = _sgx_twn_detail()
    if sgx:
        # Reference = the SGX settlement of TAIEX's last trading date; the live rows' previous
        # settlement is only a fallback (right when exactly one SGX day was skipped by Taiwan).
        ref = _sgx_settle_on(sgx["symbol"], txf["spot_date"])
        if not ref:
            ref = sgx["prev_settle"] if sgx["base_date"] > txf["spot_date"] else (sgx["day_settle"] or sgx["prev_settle"])
        if ref:
            fpct = (sgx["price"] / ref - 1) * 100
            cpct = _safe_float(str(tsm_change_pct or "").replace("%", ""))
            w2, w1 = _taiex_tsmc_weight(), _EST_W_FTSE
            asof, notes = sgx["asof"], [f"台積電權重 加權{w2*100:.1f}%/富台指{w1*100:.0f}%"]

            fx = None
            try:
                fx = _fx_change_pct(datetime.strptime(txf["spot_date"] + "133000", "%Y%m%d%H%M%S").replace(tzinfo=_sgt()))
            except Exception:
                pass
            fxr = (fx or 0) / 100
            notes.append(f"美元/台幣 {fx:+.2f}%" if fx is not None else "匯率無資料(未修正)")
            fT = (1 + fpct / 100) * (1 + fxr) - 1
            dT = fT * 100
            if cpct is not None:
                r_ts = _EST_ALPHA * ((1 + cpct / 100) * (1 + fxr) - 1) * 100
                nq = _nq_after_close(now)
                if nq and nq[1]:
                    r_ts += _EST_BETA * nq[0]
                    notes.append(f"那指盤後 {nq[0]:+.2f}%")
                    asof = max(asof, nq[1]) if asof else nq[1]
                notes.append(f"ADR×{_EST_ALPHA}")
                dT = fT * 100 * (1 - w2) / (1 - w1) + r_ts * (w2 - w1) / (1 - w1)
            methods.append({"name": "富台指權重修正", "value": spot * (1 + dT / 100), "asof": asof,
                            "fresh": bool(asof and (now - asof).total_seconds() <= fresh_s), "detail": "・".join(notes)})

    if not methods:
        return None
    primary = next((m for m in methods if m["fresh"]), methods[-1])

    def _fmt(m):
        diff = m["value"] - spot
        return {"name": m["name"], "value": round(m["value"]), "diff": round(diff),
                "diff_pct": f"{diff / spot * 100:.2f}", "fresh": m["fresh"], "detail": m.get("detail"),
                "asof": m["asof"].strftime("%m/%d %H:%M") if m["asof"] else None}

    out = _fmt(primary)
    out.update({"spot": round(spot), "spot_date": txf["spot_date"], "methods": [_fmt(m) for m in methods]})
    return out


def fetch_stwn_robust():
    """Fetch SGX FTSE Taiwan Index Futures (front month) via Yahoo Finance.

    Yahoo has no continuous ticker for this contract — it's listed per
    contract-month as TWN-<month code><yy>.SI (e.g. TWN-U26.SI = Sep 2026).
    We probe the current + next 2 months and pick whichever has real trading
    volume (the actively-traded front month; older/unlisted months 404 or
    show near-zero volume).
    """
    from datetime import date, datetime, timezone, timedelta

    headers = HEADERS
    today = date.today()

    def add_months(d, n):
        m = d.month - 1 + n
        y = d.year + m // 12
        m = m % 12 + 1
        return d.replace(year=y, month=m, day=1)

    best = None  # (volume, price, change, change_pct)
    for i in range(3):
        cand = add_months(today, i)
        sym = f"TWN-{_futures_month_symbol(cand)}.SI"
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1h&range=10d"
            r = requests.get(url, headers=headers, timeout=10)
            jd = r.json()
            result = jd.get("chart", {}).get("result") or []
            if not result:
                continue
            res = result[0]
            meta = res.get("meta", {})
            price = float(meta.get("regularMarketPrice") or 0)
            volume = float(meta.get("regularMarketVolume") or 0)
            if price <= 100:  # sanity check — trades ~3000-4000 points
                continue

            # Derive change vs prior trading day's last close (SGT) from hourly candles —
            # the daily-close series for these thin contracts is often only 1 point deep.
            prev_close = None
            try:
                closes = res["indicators"]["quote"][0]["close"]
                timestamps = res["timestamp"]
                tz = timezone(timedelta(hours=8))  # SGT
                by_day = {}
                for ts, c in zip(timestamps, closes):
                    if c is None:
                        continue
                    d = datetime.fromtimestamp(ts, tz).date()
                    by_day[d] = c  # keep overwriting -> last close of the day
                days = sorted(by_day)
                if len(days) >= 2:
                    prev_close = by_day[days[-2]]
                    price = by_day[days[-1]]
            except Exception:
                pass
            if prev_close is None:
                prev_close = float(meta.get("chartPreviousClose") or 0) or None

            change = round(price - prev_close, 2) if prev_close else 0.0
            pct = round(change / prev_close * 100, 2) if prev_close else 0.0

            if best is None or volume > best[0]:
                best = (volume, price, change, pct)
        except Exception as e:
            print(f"SGX TWN futures error ({sym}): {e}")

    if best:
        _, price, change, pct = best
        return {
            "price": str(round(price, 2)),
            "change": f"+{change}" if change > 0 else str(change),
            "change_pct": f"{pct}%"
        }
    return {"price": "-", "change": "-", "change_pct": "-"}

def fetch_tsm_adr():
    try:
        tk = yf.Ticker("TSM").fast_info
        price = round(float(tk.last_price or 0), 2)
        prev = round(float(tk.previous_close or 0), 2)
        if prev > 0:
            change = round(price - prev, 2)
            change_pct = round((change / prev) * 100, 2)
            return {
                "price": str(price),
                "change": f"+{change}" if change > 0 else str(change),
                "change_pct": f"{change_pct}%"
            }
    except Exception as e:
        print(f"Error fetching TSM ADR: {e}")
    return {"price": "-", "change": "-", "change_pct": "-"}

def fetch_yf_metric(ticker_symbol):
    try:
        tk = yf.Ticker(ticker_symbol).fast_info
        price = round(float(tk.last_price or 0), 3)
        prev = round(float(tk.previous_close or 0), 3)
        change = round(price - prev, 3)
        change_pct = round((change / prev) * 100, 2) if prev > 0 else 0
        return {"current": price, "prev": prev, "change": f"+{change}" if change > 0 else str(change), "change_pct": f"{change_pct}%"}
    except Exception as e:
        print(f"Error fetching YF {ticker_symbol}: {e}")
    return {"current": None, "prev": None, "change": "-", "change_pct": "-"}

def fetch_macromicro_metric(url):
    """Helper for metrics from MacroMicro chart data."""
    res = fetch_macromicro(url)
    if res["current"] is not None:
        curr, prev = res["current"], res["prev"]
        change = round(curr - prev, 2)
        pct = round((change / prev) * 100, 2) if prev and prev > 0 else 0
        return {
            "price": str(curr),
            "change": f"+{change}" if change > 0 else str(change),
            "change_pct": f"{pct}%",
            "current": curr, # for compatibility
            "prev": prev
        }
    return {"price": "-", "change": "-", "change_pct": "-", "current": None, "prev": None}

def fetch_taiex_margin_ratio():
    """
    Compute 台股大盤融資維持率 directly from TWSE OpenAPI — no third-party dependency.

    融資維持率 = 擔保品市值 / 融資債務 × 100%
               = Σ(融資餘額_千股 × 收盤價) / 融資金額_仟元 × 100%

    Data sources (all free TWSE public APIs):
      - openapi.twse.com.tw/v1/exchangeReport/MI_MARGN   → per-stock margin lots
      - openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL → per-stock closing price
      - twse.com.tw/rwd/zh/marginTrading/MI_MARGN?selectType=MS → total debt (仟元)

    Cached for 6 hours (TWSE publishes after-hours data daily).
    """
    global _margin_ratio_cache
    now = time.time()
    if _margin_ratio_cache["data"] and (now - _margin_ratio_cache["ts"]) < 21600:
        return _margin_ratio_cache["data"]

    ua = HEADERS
    try:
        # ── 1. Per-stock margin positions (in 千股 / lots) ────────────────────
        r_margin = requests.get(
            "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN",
            headers=ua, timeout=20, verify=False
        )
        margin_list = r_margin.json()  # [{股票代號, 融資今日餘額, ...}, ...]

        # ── 2. Per-stock closing prices ───────────────────────────────────────
        r_prices = requests.get(
            "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
            headers=ua, timeout=20, verify=False
        )
        price_map = {}
        for item in r_prices.json():
            code = str(item.get("Code", "")).strip()
            try:
                p = float(str(item.get("ClosingPrice", "") or "").replace(",", ""))
                if p > 0:
                    price_map[code] = p
            except Exception:
                pass

        # ── 3. Total margin debt (仟元) from summary ──────────────────────────
        r_sum = requests.get(
            "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN",
            params={"response": "json", "selectType": "MS"},
            headers=ua, timeout=15, verify=False
        )
        r_sum_json = r_sum.json()
        total_debt_kt = 0.0
        for table in r_sum_json.get("tables", []):
            for row in table.get("data", []):
                if "融資金額" in str(row[0]):
                    # fields: 項目|買進|賣出|現金(券)償還|前日餘額|今日餘額
                    total_debt_kt = float(str(row[5]).replace(",", ""))  # index 5 = 今日餘額
                    break

        if total_debt_kt <= 0:
            raise ValueError("Could not read total margin debt from TWSE")

        # TWSE 只在收盤結算後才把「今日餘額」換成新的一天 — 開盤前/結算前這支
        # API 的 date 欄位還停在上一個交易日。fetch_twse_margin() (融資餘額卡)
        # 已經會檢查這個並標記 stale，這裡如果不比照辦理，就會把「其實是昨天」
        # 的資料當成「今天」存進 ratio 歷史，跟餘額卡的漲跌基準對不齊，
        # 出現「餘額減少、維持率卻增加」這種比較基準不一致的假象。
        resp_raw = r_sum_json.get("date", "")
        resp_date = f"{resp_raw[:4]}-{resp_raw[4:6]}-{resp_raw[6:8]}" if len(resp_raw) == 8 else ""

        # ── 4. Compute collateral value (仟元) ────────────────────────────────
        # 融資今日餘額 unit = 千股 (lots); price unit = NTD/share
        # collateral_千元 = Σ (lots × 1000 shares × price) / 1000 = Σ (lots × price)
        collateral_kt = 0.0
        for item in margin_list:
            code = str(item.get("股票代號", "")).strip()
            try:
                lots = float(str(item.get("融資今日餘額", "0") or "0").replace(",", ""))
            except Exception:
                lots = 0.0
            if lots <= 0:
                continue
            price = price_map.get(code)
            if price:
                collateral_kt += lots * price

        # ── 5. Ratio ──────────────────────────────────────────────────────────
        ratio = collateral_kt / total_debt_kt * 100.0
        from datetime import datetime, timezone, timedelta as _td
        tw_today = datetime.now(tz=timezone(_td(hours=8))).date()
        tw_today_str = tw_today.isoformat()
        is_stale = (resp_date != tw_today_str) if resp_date else False
        # Key the value under the trading day it actually represents (resp_date
        # when stale), not blindly under "today" — keeps the history's date
        # labels honest so tomorrow's "prev" lookup isn't itself a stale dupe.
        value_date = resp_date if (is_stale and resp_date) else tw_today_str
        tw_yesterday = (datetime.fromisoformat(value_date).date() - _td(days=1)).isoformat()
        hist = _load_ratio_history()
        prev_val = hist.get(tw_yesterday, {}).get("tse")
        result = {"current": round(ratio, 2), "prev": prev_val}
        if is_stale:
            result["stale"] = True
        # Persist under the value's real trading date
        entry = hist.get(value_date, {})
        entry["tse"] = result["current"]
        hist[value_date] = entry
        _save_ratio_history(hist)
        _margin_ratio_cache = {"ts": now, "data": result}
        return result

    except Exception as e:
        print(f"Error computing taiex margin ratio: {e}")

    # Return stale cache if available
    if _margin_ratio_cache["data"]:
        return _margin_ratio_cache["data"]
    return {"current": None, "prev": None}


def fetch_tpex_margin_ratio():
    """
    Compute 上櫃融資維持率 from TPEX APIs — no third-party dependency.

    上櫃融資維持率 = Σ(資餘額_張 × 收盤價) / 融資金額_仟元 × 100%

    1 張 = 1000 shares; price = NTD/share
    → collateral_仟元 = Σ(lots_張 × price)   [same unit math as TWSE 千股 × price]

    Data sources:
      - tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php
          → per-stock lots (row[6] = 資餘額 in 張) + summary total debt
      - tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes
          → per-stock closing prices (SecuritiesCompanyCode, Close)

    Cached for 6 hours.
    """
    global _tpex_margin_ratio_cache
    now = time.time()
    if _tpex_margin_ratio_cache["data"] and (now - _tpex_margin_ratio_cache["ts"]) < 21600:
        return _tpex_margin_ratio_cache["data"]

    def _last_good_from_history():
        hist = _load_ratio_history()
        for d in sorted(hist, reverse=True):
            v = hist[d].get("tpex")
            if v is not None:
                return {"current": v, "prev": v}
        return {"current": None, "prev": None}

    # All attempts failed recently — skip straight to a fallback instead of
    # hammering TPEX with 3 more retries on every request during an outage.
    fail_ts = _tpex_margin_ratio_cache.get("fail_ts", 0.0)
    if fail_ts and (now - fail_ts) < _MARGIN_COOLDOWN:
        return _tpex_margin_ratio_cache["data"] or _last_good_from_history()

    import json as _json
    ua = HEADERS
    last_err = None
    for attempt in range(_MARGIN_RETRIES):
        try:
            # ── 1. Per-stock margin positions + total debt ────────────────────
            r_margin = requests.get(
                "https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php",
                params={"l": "zh-tw", "o": "json", "s": "0,asc"},
                headers=ua, timeout=20, verify=False
            )
            r_margin.raise_for_status()
            if not r_margin.content:
                raise ValueError("TPEX margin_bal_result: empty response body")
            try:
                raw = r_margin.content.decode("cp950", errors="replace")
            except Exception:
                raw = r_margin.text
            margin_data = _json.loads(raw)
            tables = margin_data.get("tables", [])
            if not tables:
                raise ValueError("TPEX margin_bal_result: empty tables")

            margin_rows = tables[0].get("data", [])
            summary = tables[0].get("summary", [])

            # summary[1][6] = 融資金額 今日餘額 (仟元)
            if len(summary) < 2 or len(summary[1]) < 7:
                raise ValueError(f"TPEX summary format unexpected: {summary}")
            total_debt_kt = float(str(summary[1][6]).replace(",", ""))
            if total_debt_kt <= 0:
                raise ValueError("TPEX total margin debt is 0 or missing")

            # 同一支 API fetch_tpex_margin() (融資餘額卡) 已經在檢查這個 date 欄位
            # 判斷 stale — 這裡比照辦理，避免把還沒結算的舊資料當「今天」存進歷史。
            resp_raw = margin_data.get("date", "")
            resp_date = f"{resp_raw[:4]}-{resp_raw[4:6]}-{resp_raw[6:8]}" if len(resp_raw) == 8 else ""

            # ── 2. TPEX closing prices ─────────────────────────────────────────
            r_prices = requests.get(
                "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
                headers=ua, timeout=20, verify=False
            )
            r_prices.raise_for_status()
            if not r_prices.content:
                raise ValueError("TPEX daily_close_quotes: empty response body")
            price_map = {}
            for item in r_prices.json():
                code = str(item.get("SecuritiesCompanyCode", "")).strip()
                try:
                    p = float(str(item.get("Close", "") or "").replace(",", ""))
                    if p > 0:
                        price_map[code] = p
                except Exception:
                    pass

            # ── 3. Collateral value (仟元) ───────────────────────────────────────
            # row[0]=代號, row[6]=資餘額(張); collateral_仟元 = Σ(lots_張 × price)
            collateral_kt = 0.0
            for row in margin_rows:
                if len(row) < 7:
                    continue
                code = str(row[0]).strip()
                try:
                    lots = float(str(row[6]).replace(",", ""))
                except Exception:
                    lots = 0.0
                if lots <= 0:
                    continue
                price = price_map.get(code)
                if price:
                    collateral_kt += lots * price

            # ── 4. Ratio ─────────────────────────────────────────────────────────
            ratio = collateral_kt / total_debt_kt * 100.0
            from datetime import datetime, timezone, timedelta as _td
            tw_today = datetime.now(tz=timezone(_td(hours=8))).date()
            tw_today_str = tw_today.isoformat()
            is_stale = (resp_date != tw_today_str) if resp_date else False
            # Key under the trading day this data actually represents, not
            # blindly "today", so tomorrow's lookup doesn't hit a stale dupe.
            value_date = resp_date if (is_stale and resp_date) else tw_today_str
            hist = _load_ratio_history()
            # Most recent prior day that actually has a value (skips weekends/holidays
            # where nothing was fetched, instead of hard-coding "yesterday").
            prev_val = None
            for d in sorted((k for k in hist if k < value_date), reverse=True):
                v = hist[d].get("tpex")
                if v is not None:
                    prev_val = v
                    break
            result = {"current": round(ratio, 2), "prev": prev_val}
            if is_stale:
                result["stale"] = True
            # Persist under the value's real trading date
            entry = hist.get(value_date, {})
            entry["tpex"] = result["current"]
            hist[value_date] = entry
            _save_ratio_history(hist)
            _tpex_margin_ratio_cache = {"ts": now, "data": result, "fail_ts": 0.0}
            return result

        except Exception as e:
            last_err = e
            if attempt < _MARGIN_RETRIES - 1:
                time.sleep(1)

    print(f"Error computing TPEX margin ratio (all {_MARGIN_RETRIES} attempts failed): {last_err}")
    _tpex_margin_ratio_cache["fail_ts"] = now

    # Fall back to the last persisted value (in-memory, then on disk) so a
    # restart during a TPEX outage doesn't blank the card out entirely.
    return _tpex_margin_ratio_cache["data"] or _last_good_from_history()


def _fetch_wtx():
    """Fetch WTX 台指期 — Yahoo TW HTML first, fallback to ^TWII spot via yfinance."""
    # 1. Try existing Yahoo TW scraper
    result = fetch_yahoo_future("WTX%26")
    if result.get("price") not in ("-", None):
        return result
    # 2. Fallback: yfinance TAIEX spot index (^TWII) as proxy
    try:
        tk = yf.Ticker("^TWII").fast_info
        price = round(float(tk.last_price or 0), 0)
        prev  = round(float(tk.previous_close or 0), 0)
        if price > 1000:
            change = round(price - prev, 0)
            pct    = round((change / prev) * 100, 2) if prev else 0
            return {
                "price":      str(int(price)),
                "change":     f"+{int(change)}" if change > 0 else str(int(change)),
                "change_pct": f"{pct}%",
            }
    except Exception as e:
        print(f"[WTX fallback ^TWII] {e}")
    return {"price": "-", "change": "-", "change_pct": "-"}


import json as _chip_json
from datetime import date as _date, timedelta as _timedelta
from pathlib import Path as _Path

_CHIP_FILE = _Path(__file__).parent / "data" / "chip_cache.json"
_chip_mem:  dict = {}   # in-memory mirror of _CHIP_FILE
_chip_file_loaded = False

def _last_saturday() -> "_date":
    """Return the most recent Saturday (today if today IS Saturday)."""
    today = _date.today()
    days_since_sat = (today.weekday() - 5) % 7  # Mon=0 … Sat=5 → 0
    return today - _timedelta(days=days_since_sat)

def _chip_valid(entry: dict) -> bool:
    """Cache is valid when fetched on or after the most recent Saturday AND
    the cached week's data isn't stale.

    norway.twsthr.info doesn't always have the new week's numbers up by
    Saturday — sometimes it lands Sunday/Monday. If we happen to fetch right
    before it updates, `fetch_date` alone would lock in last week's data for
    a full week. So also require the cached `current_date` to be recent
    (<=8 days old); otherwise treat as stale and retry.
    """
    try:
        if _date.fromisoformat(entry["fetch_date"]) < _last_saturday():
            return False
        cur = entry.get("data", {}).get("current_date")
        if cur:
            cur_d = _date(int(cur[:4]), int(cur[4:6]), int(cur[6:8]))
            if (_date.today() - cur_d).days > 8:
                return False
        return True
    except Exception:
        return False

def _load_chip_file():
    global _chip_mem, _chip_file_loaded
    if _chip_file_loaded:
        return
    try:
        if _CHIP_FILE.exists():
            _chip_mem = _chip_json.loads(_CHIP_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[chip] load cache error: {e}")
    _chip_file_loaded = True

_chip_dirty = False   # set True when new data is scraped; cleared by chip_cache_pop_dirty()

def _save_chip_file():
    global _chip_dirty
    try:
        _CHIP_FILE.parent.mkdir(parents=True, exist_ok=True)
        _CHIP_FILE.write_text(
            _chip_json.dumps(_chip_mem, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        _chip_dirty = True
    except Exception as e:
        print(f"[chip] save cache error: {e}")

def chip_cache_pop_dirty() -> bool:
    """Returns True (and resets flag) if chip_cache.json was updated since last call."""
    global _chip_dirty
    dirty, _chip_dirty = _chip_dirty, False
    return dirty

def fetch_chip_data(symbol: str) -> dict:
    """
    Scrape major shareholder (>400 lots) weekly data from norway.twsthr.info.

    Table is a pivot: rows = shareholding tiers, columns = weeks.
    Structure per data row: [empty, label, 人數_w1, 張數_w1, %_w1, empty, 人數_w2, 張數_w2, ...]
    '* 400 張以上' row → cells[3]=curr_big, cells[7]=prev_big
    '合計'         row → cells[3]=total (集保總張數)
    Dates extracted from thead (8-digit numeric cells).

    Formula: change_pct = (curr_big - prev_big) / total * 100
    (relative to total shares, matching KGI display convention)

    Returns {total, current, prev, change, change_pct, current_date, prev_date}
    or {error: "..."} on failure.
    """
    symbol = str(symbol).strip()
    _load_chip_file()
    entry = _chip_mem.get(symbol)
    if entry and _chip_valid(entry):
        return entry["data"]

    url = f"https://norway.twsthr.info/StockHolders.aspx?stock={symbol}"
    hdrs = {**HEADERS, "Referer": "https://norway.twsthr.info/"}
    try:
        r = requests.get(url, hdrs, timeout=15, verify=False)
        soup = BeautifulSoup(r.text, "html.parser")

        def _int(s):
            try:
                return int(str(s).replace(",", "").strip())
            except Exception:
                return 0

        # ── Dates from thead ──────────────────────────────────────────────────
        dates = []
        thead = soup.find("thead")
        if thead:
            for th in thead.find_all(["th", "td"]):
                t = th.get_text(strip=True)
                if t.isdigit() and len(t) == 8:
                    dates.append(t)

        # ── Rows ─────────────────────────────────────────────────────────────
        tbody = soup.find("tbody")
        if not tbody:
            return {"error": "no table"}

        row_400 = None
        row_total = None
        for tr in tbody.find_all("tr"):
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) < 8:
                continue
            label = cells[1]
            if "400" in label and "以上" in label:
                row_400 = cells
            elif label == "合計":
                row_total = cells

        if not row_400 or not row_total:
            return {"error": "rows not found"}

        total = _int(row_total[3])  # 集保總張數
        if total <= 0:
            return {"error": "total=0"}

        # ── Per-week big-holder data ──────────────────────────────────────────
        # Column pattern per week k (0=latest): 張數 at index 3 + 4*k
        weeks = []
        for k, d in enumerate(dates):
            col = 3 + 4 * k
            if col < len(row_400):
                weeks.append({"date": d, "big": _int(row_400[col])})

        if len(weeks) < 2:
            return {"error": "not enough week data"}

        curr_big = weeks[0]["big"]
        prev_big = weeks[1]["big"]
        change = curr_big - prev_big
        change_pct = round(change / total * 100, 2)

        # ── Consecutive run detection ─────────────────────────────────────────
        # direction based on week0 vs week1
        if curr_big > prev_big:
            direction = "up"
        elif curr_big < prev_big:
            direction = "down"
        else:
            direction = "flat"

        run_start_idx = 1  # run covers at least week0→week1
        if direction != "flat":
            for i in range(2, len(weeks)):
                # For downtrend: older week should have MORE big holders
                # For uptrend:   older week should have FEWER big holders
                extends = (
                    (direction == "down" and weeks[i]["big"] > weeks[i - 1]["big"]) or
                    (direction == "up"   and weeks[i]["big"] < weeks[i - 1]["big"])
                )
                if extends:
                    run_start_idx = i
                else:
                    break

        run_start    = weeks[run_start_idx]
        run_change   = curr_big - run_start["big"]
        run_change_pct = round(run_change / total * 100, 2)
        run_weeks    = run_start_idx + 1   # number of weeks in the run

        result = {
            "total":          total,
            "current":        curr_big,
            "prev":           prev_big,
            "change":         change,
            "change_pct":     change_pct,       # week0 vs week1 (flat detection)
            "run_change":     run_change,
            "run_change_pct": run_change_pct,   # cumulative across consecutive run
            "run_weeks":      run_weeks,
            "current_date":   weeks[0]["date"],
            "prev_date":      weeks[1]["date"],
            "run_start_date": run_start["date"],
        }
        _chip_mem[symbol] = {"fetch_date": _date.today().isoformat(), "data": result}
        _save_chip_file()
        return result

    except Exception as e:
        print(f"[chip] {symbol} error: {e}")
        return {"error": str(e)}


def scrape_important_info(force=False):
    global _info_cache
    now = time.time()

    if not force and _info_cache["ts"] and (now - _info_cache["ts"]) < CACHE_TTL:
        return _info_cache["data"]

    # Fetch all data concurrently
    with ThreadPoolExecutor(max_workers=10) as executor:
        f_us10y       = executor.submit(fetch_yf_metric, "^TNX")
        f_taiex_ratio = executor.submit(fetch_taiex_margin_ratio)
        f_tpex_ratio  = executor.submit(fetch_tpex_margin_ratio)
        f_brent       = executor.submit(fetch_yf_metric, "BZ=F")
        f_wtx         = executor.submit(_fetch_wtx)
        f_twncon      = executor.submit(fetch_cnyes_twncon)
        f_tsm         = executor.submit(fetch_tsm_adr)
        f_vix         = executor.submit(fetch_taiwan_vix)
        f_margin_tse  = executor.submit(fetch_twse_margin, force)
        f_margin_otc  = executor.submit(fetch_tpex_margin, force)

        data = {
            "us_10y_bond":        f_us10y.result(),
            "taiex_margin_ratio": f_taiex_ratio.result(),
            "tpex_margin_ratio":  f_tpex_ratio.result(),
            "brent":              f_brent.result(),
            "wtx":                f_wtx.result(),
            "twncon":             f_twncon.result(),
            "tsm_adr":            f_tsm.result(),
            "vixtwn":             f_vix.result(),
            "margin_balance_tse": f_margin_tse.result(),
            "margin_balance_otc": f_margin_otc.result(),
        }

    try:
        data["taiex_open_est"] = estimate_taiex_open((data.get("tsm_adr") or {}).get("change_pct"))
    except Exception as e:
        print(f"[taiex_open_est] {e}")
        data["taiex_open_est"] = None

    _info_cache["ts"] = now
    _info_cache["data"] = data
    return data


_ISIN_CODE_RE = re.compile(r'^[1-9]\d{3}$')


def fetch_industry_classification() -> dict:
    """全市場(上市+上櫃)個股產業分類，來源 TWSE ISIN 一覽表
    (strMode=2 上市 / strMode=4 上櫃) — 官方公告的「產業別」文字，非自建對照表。
    Returns {code: {"name": str, "industry": str, "market": "tse"|"otc"}}."""
    out: dict = {}
    for mode, market in ((2, "tse"), (4, "otc")):
        try:
            r = requests.get(
                f"https://isin.twse.com.tw/isin/C_public.jsp?strMode={mode}",
                headers=HEADERS, timeout=20, verify=False)
            text = None
            for enc in ("big5", "cp950", "utf-8-sig", "utf-8"):
                try:
                    text = r.content.decode(enc)
                    break
                except (UnicodeDecodeError, LookupError):
                    continue
            if not text:
                continue
            soup = BeautifulSoup(text, "html.parser")
            table = soup.find("table", attrs={"class": "h4"})
            if not table:
                continue
            section = ""
            for tr in table.find_all("tr"):
                tds = tr.find_all("td")
                if len(tds) == 1 and tds[0].get("colspan"):
                    section = tds[0].get_text(strip=True)
                    continue
                if len(tds) != 7 or section != "股票":
                    continue
                m = re.match(r'^(\d{4,6})\s*(.+)$', tds[0].get_text(strip=True))
                if not m:
                    continue
                code, name = m.group(1), m.group(2).strip()
                if not _ISIN_CODE_RE.match(code):
                    continue
                industry = tds[4].get_text(strip=True)
                if not industry:
                    continue
                out[code] = {"name": name, "industry": industry, "market": market}
        except Exception as e:
            print(f"[industry-class] {market} error: {e}")
    return out
