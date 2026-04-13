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
        price = float(price_m.group(1)) if price_m else None
        pct = 0.0
        pct_matches = re.findall(r'>\s*\(?([-+0-9.]+%)\)?\s*<', html)
        if not pct_matches:
            pct_matches = re.findall(r'>([^<]*?[\d.]+%)<', html)
        if pct_matches:
            pct_str = pct_matches[0].replace('%', '').replace('(', '').replace(')', '').replace('+', '').strip()
            try:
                pct = float(pct_str)
                idx = html.find(pct_matches[0])
                search_area = html[max(0, idx-1000) : idx+200]
                if 'c-trend-down' in search_area:
                    pct = -abs(pct)
                elif 'c-trend-up' in search_area:
                    pct = abs(pct)
            except: pass
        return {"price": price, "change_pct": pct}
    except Exception as e:
        return {"error": str(e)}

print(f"OTC: {_fetch_yahoo_tw_scrape('^TWOII', 'otc')}")
print(f"TAIEX: {_fetch_yahoo_tw_scrape('^TWII', 'tse')}")
print(f"6826: {_fetch_yahoo_tw_scrape('6826', 'otc')}")
