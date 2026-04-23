import json
import re
import time
import urllib3
import requests
from bs4 import BeautifulSoup
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor

urllib3.disable_warnings()

CACHE_TTL = 300 # 5 minutes cache
_info_cache = {"ts": 0, "data": {}}

FIRECRAWL_API_KEY = "fc-d6d780def05343a5b032c3d22e89e15d"
_margin_ratio_cache = {"ts": 0, "data": None}  # daily data — cache 6 hours

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

_twse_margin_cache = {"date": "", "data": None}   # daily

def _safe_float(v):
    """Parse a string that may be '-', '', or a comma-number."""
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None

def fetch_twse_margin():
    # Row layout of MI_MARGN tables[0].data:
    #   [0] 融資(交易單位)   cols [4]=前日 [5]=今日  (in 張)
    #   [1] 融券(交易單位)
    #   [2] 融資金額(仟元)   cols [4]=前日 [5]=今日  ← the one we want
    from datetime import date
    today_str = date.today().isoformat()
    if _twse_margin_cache["date"] == today_str and _twse_margin_cache["data"]:
        return _twse_margin_cache["data"]
    try:
        r = requests.get(
            "https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json",
            headers=HEADERS, verify=False, timeout=15
        )
        r.raise_for_status()
        tables = r.json().get("tables", [])
        if not tables:
            print("[TWSE margin] empty tables — market closed or pre-data")
            return {"balance": None, "increase": None}

        data = tables[0].get("data", [])
        if len(data) < 3:
            print(f"[TWSE margin] unexpected row count: {len(data)}")
            return {"balance": None, "increase": None}

        row = data[2]   # 融資金額(仟元) is always index 2
        if len(row) < 6:
            print(f"[TWSE margin] short row: {row}")
            return {"balance": None, "increase": None}

        yest_val  = _safe_float(row[4])   # 前日餘額(仟元)
        today_val = _safe_float(row[5])   # 今日餘額(仟元)
        if today_val is None:
            print(f"[TWSE margin] non-numeric today value: {row}")
            return {"balance": None, "increase": None}

        increase = (today_val - yest_val) if yest_val is not None else 0
        result = {
            "balance":  round(today_val / 100000, 2),   # 仟元 → 億
            "increase": round(increase  / 100000, 2),
        }
        _twse_margin_cache["date"] = today_str
        _twse_margin_cache["data"] = result
        return result
    except Exception as e:
        print(f"[TWSE margin] error: {type(e).__name__}: {e}")
    return {"balance": None, "increase": None}

_tpex_margin_cache = {"date": "", "data": None}   # daily

def fetch_tpex_margin():
    """
    Fetch TPEX total margin balance (融資餘額).
    summary[0] → lot-count units (仟張)
    summary[1] → value units (仟元)  ← this is what we want
    Cols: [0]=代號 [1]=名稱 [2]=前日餘額 [3]=買進 [4]=賣出 [5]=還款 [6]=今日餘額
    """
    from datetime import date
    import json as _json
    today_str = date.today().isoformat()
    if _tpex_margin_cache["date"] == today_str and _tpex_margin_cache["data"]:
        return _tpex_margin_cache["data"]
    try:
        url = ("https://www.tpex.org.tw/web/stock/margin_trading/margin_balance"
               "/margin_bal_result.php?l=zh-tw&o=json")
        r = requests.get(url, headers=HEADERS, verify=False, timeout=15)
        r.raise_for_status()
        # TPEX responds in cp950; fall back to utf-8 if decode fails
        try:
            raw = r.content.decode("cp950", errors="replace")
        except Exception:
            raw = r.text
        data = _json.loads(raw)
        tables = data.get("tables", [])
        if not tables:
            print("[TPEX margin] empty tables — market closed or pre-data")
            return {"balance": None, "increase": None}

        summary = tables[0].get("summary", [])
        if not summary:
            print(f"[TPEX margin] no summary in table; keys={list(tables[0].keys())}")
            return {"balance": None, "increase": None}

        # summary[0] = 合計(仟張) — lot count
        # summary[1] = 合計金額(仟元) — TWD value  ← the one we want
        # cols: [2]=前日餘額 [6]=今日餘額
        if len(summary) < 2:
            print(f"[TPEX margin] only {len(summary)} summary rows, expected 2")
            return {"balance": None, "increase": None}

        row = summary[1]
        if len(row) < 7:
            print(f"[TPEX margin] short summary row: {row}")
            return {"balance": None, "increase": None}

        today_val = _safe_float(row[6])   # 今日餘額(仟元)
        yest_val  = _safe_float(row[2])   # 前日餘額(仟元)
        if today_val is None:
            print(f"[TPEX margin] non-numeric today value in row: {row}")
            return {"balance": None, "increase": None}

        increase = (today_val - yest_val) if yest_val is not None else 0
        result = {
            "balance":  round(today_val / 100000, 2),   # 仟元 → 億
            "increase": round(increase  / 100000, 2),
        }
        _tpex_margin_cache["date"] = today_str
        _tpex_margin_cache["data"] = result
        return result
    except Exception as e:
        print(f"[TPEX margin] error: {type(e).__name__}: {e}")

    return {"balance": None, "increase": None}

def fetch_yahoo_future(symbol_encoded):
    """Fetch futures from Yahoo Finance Taiwan."""
    try:
        url = f"https://tw.stock.yahoo.com/future/{symbol_encoded}"
        r = requests.get(url, headers=HEADERS, verify=False, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")

        # Try multiple potential selectors for Yahoo's new layout
        price_el = (soup.select_one('span[class*="Fz(32px)"]')
                    or soup.select_one('[class*="Fw(b)"][class*="Fz(32px)"]'))
        change_el = (soup.select_one('span[class*="Fz(20px)"]')
                     or soup.select_one('span[class*="C($"]'))

        if price_el:
            price_str = price_el.text.strip()
            change_text = change_el.text.strip() if change_el else "-"

            change_val = "-"
            change_pct = "-"
            if "(" in change_text:
                parts = change_text.split("(")
                change_val = parts[0].strip()
                change_pct = parts[1].replace(")", "").strip()
            else:
                change_val = change_text

            # Try to compute pct if missing, and ensure sign on change
            try:
                price_num = float(price_str.replace(",", ""))
                change_num = float(str(change_val).replace(",", "").replace("+", "").replace("-", ""))
                # Detect sign from text; if none and value is near 0 skip
                is_neg = change_text.startswith("-") or (change_val.startswith("-") if change_val != "-" else False)
                if not change_val.startswith("+") and not change_val.startswith("-"):
                    prev = price_num - change_num
                    if prev > 0:
                        pct_calc = round((change_num / prev) * 100, 2)
                        # Can't determine sign from HTML alone; omit sign prefix for safety
                        change_val = str(round(change_num, 2))
                        if change_pct == "-":
                            change_pct = f"{pct_calc}%"
                elif change_pct == "-":
                    prev = price_num - change_num * (-1 if is_neg else 1)
                    if prev > 0:
                        pct_calc = round((change_num / prev) * 100, 2)
                        change_pct = f"{pct_calc}%"
            except:
                pass

            return {
                "price": price_str,
                "change": change_val,
                "change_pct": change_pct
            }
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
    return {"price": "-", "change": "-", "change_pct": "-"}

def fetch_stwn_robust():
    """Fetch FTSE Taiwan futures (STWN) from multiple sources."""
    headers = HEADERS

    # 1. Try yfinance with SGX suffix
    try:
        tk = yf.Ticker("STWN.SI").fast_info
        price = float(tk.last_price or 0)
        prev = float(tk.previous_close or 0)
        if price > 100:  # sanity check — STWN trades ~3000 SGD points
            change = round(price - prev, 2)
            pct = round((change / prev) * 100, 2) if prev else 0
            return {
                "price": str(round(price, 2)),
                "change": f"+{change}" if change > 0 else str(change),
                "change_pct": f"{pct}%"
            }
    except Exception as e:
        print(f"STWN yfinance error: {e}")

    # 2. Try Yahoo Finance chart API directly (no HTML scraping)
    try:
        url = "https://query1.finance.yahoo.com/v8/finance/chart/STWN.SI?interval=1d&range=2d"
        r = requests.get(url, headers=headers, timeout=10)
        jd = r.json()
        result = jd.get("chart", {}).get("result", [])
        if result:
            meta = result[0].get("meta", {})
            price = float(meta.get("regularMarketPrice") or 0)
            prev = float(meta.get("previousClose") or meta.get("chartPreviousClose") or 0)
            if price > 100:
                change = round(price - prev, 2)
                pct = round((change / prev) * 100, 2) if prev else 0
                return {
                    "price": str(round(price, 2)),
                    "change": f"+{change}" if change > 0 else str(change),
                    "change_pct": f"{pct}%"
                }
    except Exception as e:
        print(f"STWN Yahoo chart API error: {e}")

    # 3. Try Google Finance embedded JSON (STWN:SGX)
    try:
        url = "https://www.google.com/finance/quote/STWN:SGX"
        r = requests.get(url, headers=headers, timeout=10)
        # Google Finance embeds price in JSON-like script blocks
        p_match = re.search(r'data-last-price="([^"]+)"', r.text)
        prev_match = re.search(r'data-previous-close="([^"]+)"', r.text)
        if not p_match:
            # try alternate pattern in script data
            p_match = re.search(r'"regularMarketPrice":\{"raw":([\d.]+)', r.text)
            prev_match = re.search(r'"regularMarketPreviousClose":\{"raw":([\d.]+)', r.text)
        if p_match and prev_match:
            price_val = float(p_match.group(1).replace(",", ""))
            prev_val = float(prev_match.group(1).replace(",", ""))
            if price_val > 100:
                change = round(price_val - prev_val, 2)
                pct = round((change / prev_val) * 100, 2)
                return {
                    "price": str(price_val),
                    "change": f"+{change}" if change > 0 else str(change),
                    "change_pct": f"{pct}%"
                }
    except Exception as e:
        print(f"STWN Google Finance error: {e}")

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
    Fetch 台股大盤融資維持率 from MacroMicro via Firecrawl stealth proxy.
    Cached for 6 hours — TWSE publishes this daily after market close.
    """
    global _margin_ratio_cache
    now = time.time()
    if _margin_ratio_cache["data"] and (now - _margin_ratio_cache["ts"]) < 21600:
        return _margin_ratio_cache["data"]
    try:
        payload = {
            "url": "https://www.macromicro.me/charts/53117/taiwan-taiex-maintenance-margin",
            "formats": ["json"],
            "jsonOptions": {
                "prompt": (
                    "Extract the current value and previous value of 融資維持率. "
                    "Return {\"current\": float_without_percent, \"prev\": float_without_percent}"
                )
            },
            "waitFor": 8000,
            "proxy": "stealth",
        }
        r = requests.post(
            "https://api.firecrawl.dev/v1/scrape",
            json=payload,
            headers={"Authorization": f"Bearer {FIRECRAWL_API_KEY}"},
            timeout=60,
        )
        j = r.json()
        if j.get("success"):
            data_json = j.get("data", {}).get("json", {})
            curr = data_json.get("current")
            prev = data_json.get("prev")
            if curr is not None:
                result = {"current": float(curr), "prev": float(prev) if prev is not None else None}
                _margin_ratio_cache = {"ts": now, "data": result}
                return result
    except Exception as e:
        print(f"Error fetching taiex margin ratio: {e}")
    # Return stale cache if available
    if _margin_ratio_cache["data"]:
        return _margin_ratio_cache["data"]
    return {"current": None, "prev": None}


def scrape_important_info(force=False):
    global _info_cache
    now = time.time()

    if not force and _info_cache["ts"] and (now - _info_cache["ts"]) < CACHE_TTL:
        return _info_cache["data"]

    # Fetch all data concurrently
    with ThreadPoolExecutor(max_workers=10) as executor:
        f_us10y      = executor.submit(fetch_yf_metric, "^TNX")
        f_taiex_ratio = executor.submit(fetch_taiex_margin_ratio)
        f_brent      = executor.submit(fetch_yf_metric, "BZ=F")
        f_wtx        = executor.submit(fetch_yahoo_future, "WTX%26")
        f_twncon     = executor.submit(fetch_cnyes_twncon)
        f_tsm        = executor.submit(fetch_tsm_adr)
        f_margin_tse = executor.submit(fetch_twse_margin)
        f_margin_otc = executor.submit(fetch_tpex_margin)

        data = {
            "us_10y_bond":       f_us10y.result(),
            "taiex_margin_ratio": f_taiex_ratio.result(),
            "brent":             f_brent.result(),
            "wtx":               f_wtx.result(),
            "twncon":            f_twncon.result(),
            "tsm_adr":           f_tsm.result(),
            "margin_balance_tse": f_margin_tse.result(),
            "margin_balance_otc": f_margin_otc.result(),
        }

    _info_cache["ts"] = now
    _info_cache["data"] = data
    return data
