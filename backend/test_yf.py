"""Try TPEX raw data approaches."""
import requests
import urllib3
urllib3.disable_warnings()

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
}

# Method 1: TPEX aftertrading daily_close_quotes (all OTC stocks)
print("=== TPEX daily close all OTC stocks ===")
url = "https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&o=json&d=115/04/13&s=0,asc,0"
try:
    r = requests.get(url, headers=headers, timeout=15, verify=False)
    r.encoding = 'utf-8'
    data = r.json()
    rows = data.get('aaData', [])
    print(f"  Total rows: {len(rows)}")
    for row in rows:
        if len(row) > 0 and str(row[0]).strip() in ['6826', '7853']:
            print(f"  {row[0:10]}")
except Exception as e:
    print(f"  Error: {type(e).__name__}: {str(e)[:200]}")

# Method 2: TPEX stock quote API (real-time-ish)
print("\n=== TPEX stock quote ===")
for sym in ['6826', '7853']:
    url = f"https://www.tpex.org.tw/web/stock/trading/quote/quote_result.php?l=zh-tw&o=json&d=115/04/13&stkno={sym}&_=1"
    try:
        r = requests.get(url, headers=headers, timeout=10, verify=False)
        r.encoding = 'utf-8'
        print(f"  {sym} status={r.status_code}, first 300 chars: {r.text[:300]}")
    except Exception as e:
        print(f"  {sym}: {e}")

# Method 3: Just check raw response of TPEX daily trading info
print("\n=== TPEX daily trading raw ===")
for sym in ['6826', '7853']:
    url = f"https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&o=json&d=115/04&stkno={sym}"
    try:
        r = requests.get(url, headers=headers, timeout=10, verify=False)
        r.encoding = 'utf-8'
        print(f"  {sym} status={r.status_code}, content-type={r.headers.get('content-type')}")
        print(f"  first 500: {r.text[:500]}")
    except Exception as e:
        print(f"  {sym}: {e}")
