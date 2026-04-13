import requests as http_requests
import re

def _fetch_yahoo_tw_scrape(symbol: str, market: str = "tse") -> dict:
    if symbol.startswith('^'):
        url = f"https://tw.stock.yahoo.com/quote/{symbol}"
    else:
        suffix = ".TWO" if market == "otc" else ".TW"
        url = f"https://tw.stock.yahoo.com/quote/{symbol}{suffix}"
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        r = http_requests.get(url, headers=headers, timeout=10)
        html = r.text
        price_m = re.search(r'"regularMarketPrice":([0-9]+\.?[0-9]*)', html)
        if not price_m:
            price_m = re.search(r'"regularMarketPrice":\{"raw":([0-9]+\.?[0-9]*)', html)
        pct_m = re.search(r'"regularMarketChangePercent":([-?[0-9]+\.?[0-9]*)', html)
        if not pct_m:
            pct_m = re.search(r'"regularMarketChangePercent":\{"raw":([-?[0-9]+\.?[0-9]*)', html)
        
        price = float(price_m.group(1)) if price_m else None
        pct = 0.0
        if pct_m:
            pct_val = float(pct_m.group(1))
            if -1.0 < pct_val < 1.0 and pct_val != 0:
                 pct = round(pct_val * 100, 2)
            else:
                 pct = round(pct_val, 2)
        
        # og:title backup
        og_m = re.search(r'og:title" content=".*?\(([-+%\d.]+)\)', html)
        if og_m:
             try: 
                 p_str = og_m.group(1).replace('%', '').replace('+', '')
                 pct = float(p_str)
             except: pass
        return {"price": price, "change_pct": pct}
    except Exception as e:
        return {"error": str(e)}

print(f"6826: {_fetch_yahoo_tw_scrape('6826', 'otc')}")
print(f"7853: {_fetch_yahoo_tw_scrape('7853', 'otc')}")
print(f"TAIEX: {_fetch_yahoo_tw_scrape('^TWII', 'tse')}")
