import requests
import re

h = {'User-Agent': 'Mozilla/5.0'}
url = 'https://tw.stock.yahoo.com/quote/6826.TWO'
r = requests.get(url, headers=h)
html = r.text

price_m = re.search(r'"regularMarketPrice":([0-9]+\.?[0-9]*)', html)
if not price_m:
    price_m = re.search(r'"regularMarketPrice":\{"raw":([0-9]+\.?[0-9]*)', html)

price = float(price_m.group(1)) if price_m else None
pct_matches = re.findall(r'>\s*\(?([-+0-9.]+%)\)?\s*<', html)

print(f"URL: {url}")
print(f"Price: {price}")
print(f"Pct Matches: {pct_matches}")

if pct_matches:
    pct_str = pct_matches[0].replace('%', '').replace('(', '').replace(')', '').replace('+', '').strip()
    pct = float(pct_str)
    idx = html.find(pct_matches[0])
    # Search specific block
    header_area = html[max(0, idx-500) : idx+100]
    is_down = 'c-trend-down' in header_area
    is_up = 'c-trend-up' in header_area
    print(f"Header Area sample: {header_area[:200]}...")
    print(f"Down: {is_down}, Up: {is_up}")
    if is_down: pct = -abs(pct)
    elif is_up: pct = abs(pct)
    print(f"Final pct: {pct}")
