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
        
        # 1. Try to find the price
        price_m = re.search(r'"regularMarketPrice":([0-9]+\.?[0-9]*)', html)
        if not price_m:
            price_m = re.search(r'"regularMarketPrice":\{"raw":([0-9]+\.?[0-9]*)', html)
        
        # 2. Try to find the change percentage
        # Check both raw number and the one with "fmt" (usually "-6.10%")
        pct_m = re.search(r'"regularMarketChangePercent":\{"raw":([-?[0-9]*\.?[0-9]*),"fmt":"([-+%\d.]+)"\}', html)
        
        price = float(price_m.group(1)) if price_m else None
        pct = 0.0
        
        if pct_m:
            pct_str = pct_m.group(2).replace('%', '').replace('+', '')
            pct = float(pct_str)
        else:
            # Fallback for percentage: look for Fz(20px) spans or similar
            # For 6826, it might be in a span
            span_m = re.search(r'Fz\(20px\).*?>([-+%\d.]+)<', html)
            if span_m:
                pct = float(span_m.group(1).replace('%', '').replace('+', ''))

        return {"price": price, "change_pct": pct}
    except Exception as e:
        return {"error": str(e)}

print(f"6826: {_fetch_yahoo_tw_scrape('6826', 'otc')}")
print(f"7853: {_fetch_yahoo_tw_scrape('7853', 'otc')}")
print(f"TAIEX: {_fetch_yahoo_tw_scrape('^TWII', 'tse')}")
