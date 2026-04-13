import requests as http_requests
import re
import json

def debug_yahoo(symbol):
    url = f"https://tw.stock.yahoo.com/quote/{symbol}.TWO"
    headers = {"User-Agent": "Mozilla/5.0"}
    r = http_requests.get(url, headers=headers, timeout=10)
    html = r.text
    
    # Extract all regularMarketChange... fmt
    matches = re.findall(r'\"regularMarketChange(.*?)\":\{.*?\"fmt\":\"(.*?)\"', html)
    print(f"--- {symbol} ---")
    for m in matches:
        print(f"  {m[0]}: {m[1]}")
    
    # Try the Fz(20px) spans
    spans = re.findall(r'Fz\(20px\).*?>([-+%\d.]+)<', html)
    print(f"  Spans Fz(20px): {spans}")

debug_yahoo('6826')
debug_yahoo('7853')
