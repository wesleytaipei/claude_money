import requests
import re
import json

def get_yahoo_tw_data(symbol):
    url = f"https://tw.stock.yahoo.com/quote/{symbol}.TWO"
    headers = {'User-Agent': 'Mozilla/5.0'}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        # Yahoo Taiwan usually embeds data in a script tag
        # Look for "regularMarketPrice" or "regularMarketChangePercent"
        price_match = re.search(r'\"regularMarketPrice\":{\"raw\":([-?\d.]+)', r.text)
        pct_match = re.search(r'\"regularMarketChangePercent\":{\"raw\":([-?\d.]+)', r.text)
        
        price = float(price_match.group(1)) if price_match else None
        pct = float(pct_match.group(1)) * 100 if pct_match else None
        
        return {"price": price, "change_pct": round(pct, 2) if pct is not None else None}
    except Exception as e:
        return {"error": str(e)}

for s in ['6826', '7853']:
    print(f"{s}: {get_yahoo_tw_data(s)}")
