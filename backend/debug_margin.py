import requests, json, sys
sys.stdout.reconfigure(encoding='utf-8')

# TWSE
try:
    r = requests.get('https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json',
                     verify=False, timeout=15)
    d = r.json()
    tables = d.get('tables', [])
    print(f"TWSE tables: {len(tables)}")
    if tables:
        rows = tables[0].get('data', [])
        print(f"TWSE rows: {len(rows)}")
        for i, row in enumerate(rows):
            print(f"  row[{i}]: {row}")
except Exception as e:
    print(f"TWSE error: {e}")

print("---")

# TPEX
try:
    url = "https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json"
    r = requests.get(url, verify=False, timeout=15)
    raw = r.content.decode('cp950', errors='replace')
    d = json.loads(raw)
    tables = d.get('tables', [])
    print(f"TPEX tables: {len(tables)}")
    if tables:
        summary = tables[0].get('summary', [])
        print(f"TPEX summary rows: {len(summary)}")
        for i, row in enumerate(summary):
            print(f"  summary[{i}]: {row}")
except Exception as e:
    print(f"TPEX error: {e}")
