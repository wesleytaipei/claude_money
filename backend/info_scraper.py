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
_margin_ratio_cache = {"ts": 0, "data": None}       # daily data — cache 6 hours
_tpex_margin_ratio_cache = {"ts": 0, "data": None}  # daily data — cache 6 hours

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
        total_debt_kt = 0.0
        for table in r_sum.json().get("tables", []):
            for row in table.get("data", []):
                if "融資金額" in str(row[0]):
                    # fields: 項目|買進|賣出|現金(券)償還|前日餘額|今日餘額
                    total_debt_kt = float(str(row[5]).replace(",", ""))  # index 5 = 今日餘額
                    break

        if total_debt_kt <= 0:
            raise ValueError("Could not read total margin debt from TWSE")

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
        result = {"current": round(ratio, 2), "prev": None}
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

    import json as _json
    ua = HEADERS
    try:
        # ── 1. Per-stock margin positions + total debt ────────────────────────
        r_margin = requests.get(
            "https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php",
            params={"l": "zh-tw", "o": "json", "s": "0,asc"},
            headers=ua, timeout=20, verify=False
        )
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

        # ── 2. TPEX closing prices ────────────────────────────────────────────
        r_prices = requests.get(
            "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
            headers=ua, timeout=20, verify=False
        )
        price_map = {}
        for item in r_prices.json():
            code = str(item.get("SecuritiesCompanyCode", "")).strip()
            try:
                p = float(str(item.get("Close", "") or "").replace(",", ""))
                if p > 0:
                    price_map[code] = p
            except Exception:
                pass

        # ── 3. Collateral value (仟元) ────────────────────────────────────────
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

        # ── 4. Ratio ──────────────────────────────────────────────────────────
        ratio = collateral_kt / total_debt_kt * 100.0
        result = {"current": round(ratio, 2), "prev": None}
        _tpex_margin_ratio_cache = {"ts": now, "data": result}
        return result

    except Exception as e:
        print(f"Error computing TPEX margin ratio: {e}")

    if _tpex_margin_ratio_cache["data"]:
        return _tpex_margin_ratio_cache["data"]
    return {"current": None, "prev": None}


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


_chip_cache: dict = {}
_CHIP_TTL = 3600  # 1 hour — chip data published weekly, but cache for 1h

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
    now = time.time()
    cached = _chip_cache.get(symbol)
    if cached and (now - cached["ts"]) < _CHIP_TTL:
        return cached["data"]

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

        curr_big = _int(row_400[3])    # 張數 current week
        prev_big = _int(row_400[7])    # 張數 prev week
        total    = _int(row_total[3])  # 集保總張數

        if total <= 0:
            return {"error": "total=0"}

        change = curr_big - prev_big
        change_pct = round(change / total * 100, 2)

        result = {
            "total":        total,
            "current":      curr_big,
            "prev":         prev_big,
            "change":       change,
            "change_pct":   change_pct,
            "current_date": dates[0] if len(dates) > 0 else "",
            "prev_date":    dates[1] if len(dates) > 1 else "",
        }
        _chip_cache[symbol] = {"ts": now, "data": result}
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
        f_margin_tse  = executor.submit(fetch_twse_margin)
        f_margin_otc  = executor.submit(fetch_tpex_margin)

        data = {
            "us_10y_bond":        f_us10y.result(),
            "taiex_margin_ratio": f_taiex_ratio.result(),
            "tpex_margin_ratio":  f_tpex_ratio.result(),
            "brent":              f_brent.result(),
            "wtx":                f_wtx.result(),
            "twncon":             f_twncon.result(),
            "tsm_adr":            f_tsm.result(),
            "margin_balance_tse": f_margin_tse.result(),
            "margin_balance_otc": f_margin_otc.result(),
        }

    _info_cache["ts"] = now
    _info_cache["data"] = data
    return data
