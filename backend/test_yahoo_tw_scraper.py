import requests
import re
import json
import logging

def _fetch_yahoo_tw_scrape(symbol, market="otc"):
    """
    Scrape Yahoo Finance Taiwan for accurate TW stock data.
    """
    suffix = ".TWO" if market == "otc" else ".TW"
    url = f"https://tw.stock.yahoo.com/quote/{symbol}{suffix}"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        # Look for the JSON data in the script tag
        match = re.search(r'root\.App\.main\s*=\s*({.*?});', r.text, re.DOTALL)
        if not match:
            # Fallback for newer Yahoo structure
            match = re.search(r'\"regularMarketPrice\":{\"raw\":([\d.]+)', r.text)
            if match:
                price = float(match.group(1))
                pct_match = re.search(r'\"regularMarketChangePercent\":{\"raw\":([-?\d.]+)', r.text)
                pct = float(pct_match.group(1)) * 100 if pct_match else 0
                return {"price": price, "change_pct": round(pct, 2)}
            return None
        
        data = json.loads(match.group(1))
        # Navigate through the complex Yahoo state object
        # The structure is usually context.dispatcher.stores.StockQuoteStore
        # But we can just try to find the symbol in the data
        quotes = data.get('context', {}).get('dispatcher', {}).get('stores', {}).get('StockQuoteStore', {}).get('quotes', {})
        q = quotes.get(f"{symbol}{suffix}")
        if q:
            return {
                "price": q.get('regularMarketPrice'),
                "change_pct": round(q.get('regularMarketChangePercent', 0) * 100, 2)
            }
    except Exception as e:
        print(f"Scrape error for {symbol}: {e}")
    return None

print(f"6826: {_fetch_yahoo_tw_scrape('6826', 'otc')}")
print(f"7853: {_fetch_yahoo_tw_scrape('7853', 'otc')}")
