import requests
import re

def get_yahoo_tw_meta(symbol, market="otc"):
    suffix = ".TWO" if market == "otc" else ".TW"
    url = f"https://tw.stock.yahoo.com/quote/{symbol}{suffix}"
    headers = {'User-Agent': 'Mozilla/5.0'}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        # Regex to find price and percentage from meta tag
        # Example content: "和淞 (6826.TWO) 561.00 (-6.10%) | Yahoo股市"
        pattern = r'<meta property="og:title" content=".*?\(.*?\)\s+([\d,.]+)\s+\(([-+%\d.]+)\)'
        match = re.search(pattern, r.text)
        if match:
            price_str = match.group(1).replace(',', '')
            pct_str = match.group(2).replace('%', '').replace('+', '')
            return {
                "price": float(price_str),
                "change_pct": float(pct_str)
            }
    except Exception as e:
        print(f"Error {symbol}: {e}")
    return None

for s in ['6826', '7853']:
    print(f"{s}: {get_yahoo_tw_meta(s)}")
