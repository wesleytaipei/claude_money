"""
Seed 00991A and 00992A history with 2026-04-23 data so today's fetch shows changes.
Run once: python seed_etf_history.py
"""
import json, sys, io, requests
from pathlib import Path
import pandas as pd

sys.stdout.reconfigure(encoding='utf-8')
urllib3 = __import__('urllib3')
urllib3.disable_warnings()

DATA_DIR = Path(__file__).parent / 'data'

def load_json(p):
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return {}

def save_json(p, obj):
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')

def parse_pct(s):
    try:
        return float(str(s).replace('%', '').strip())
    except Exception:
        return 0.0

def parse_shares(s):
    try:
        return int(str(s).replace(',', '').replace('*', '').strip())
    except Exception:
        return 0

def parse_ntd(s):
    try:
        return float(str(s).replace('NTD', '').replace(',', '').strip())
    except Exception:
        return None

# ── 00991A: fhtrust 2026-04-23 ───────────────────────────────────────────────
print("=== Seeding 00991A (fhtrust 20260423) ===")
url = 'https://www.fhtrust.com.tw/api/assetsExcel/ETF23/20260423'
r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=30, verify=False)
print(f"  status={r.status_code} size={len(r.content)}")
if r.status_code == 200 and len(r.content) > 1000:
    df = pd.read_excel(io.BytesIO(r.content), sheet_name=0, header=None)
    raw_date = str(df.iloc[2, 0]).replace('日期:', '').replace('日期：', '').strip()
    try:
        parts = raw_date.split('/')
        date_str = f'{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}'
    except Exception:
        date_str = '2026-04-23'
    aum = parse_ntd(str(df.iloc[4, 0]).replace(',', '').strip())
    try:
        nav = float(df.iloc[8, 0])
    except Exception:
        nav = None

    header_row = None
    for i, row in df.iterrows():
        if str(row.iloc[0]).strip() == '證券代號':
            header_row = i; break

    holdings = []
    if header_row is not None:
        for i in range(header_row + 1, len(df)):
            row = df.iloc[i]
            sym = str(row.iloc[0]).replace('*', '').strip()
            if not sym or sym == 'nan': break
            holdings.append({
                'symbol': sym,
                'name': str(row.iloc[1]).strip(),
                'shares': parse_shares(row.iloc[2]),
                'weight': parse_pct(row.iloc[4]),
            })

    print(f"  date={date_str} aum={aum} nav={nav} holdings={len(holdings)}")

    hist_path = DATA_DIR / 'etf_00991a_history.json'
    hist = load_json(hist_path)
    hist[date_str] = {
        'aum': aum,
        'holdings_raw': holdings,
    }
    save_json(hist_path, hist)
    print(f"  Saved {date_str} → {hist_path}")
else:
    print("  FAILED to fetch 00991A 4/23 data")

# ── 00992A: capitalfund, try date='2026-04-24' → should give date2='2026-04-23' ──
print()
print("=== Seeding 00992A (capitalfund, date=2026-04-24) ===")
cf_url = 'https://www.capitalfund.com.tw/CFWeb/api/etf/buyback'
cf_headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Referer': 'https://www.capitalfund.com.tw/etf/product/detail/500/portfolio',
}
try:
    r2 = requests.post(cf_url,
                       json={'fundId': '500', 'type': 'portfolio', 'date': '2026-04-24'},
                       headers=cf_headers, timeout=30, verify=False)
    print(f"  status={r2.status_code}")
    body = r2.json()
    print(f"  code={body.get('code')}")
    if body.get('code') == 200:
        data = body['data']
        pcf = data.get('pcf', {})
        stocks = data.get('stocks', [])
        date2 = pcf.get('date2', '')[:10]
        aum2 = pcf.get('nav')
        nav2 = pcf.get('pUnit')
        print(f"  date2={date2} aum={aum2} nav={nav2} stocks={len(stocks)}")

        holdings2 = []
        for s in stocks:
            sym = str(s.get('stocNo', '')).strip()
            if not sym: continue
            holdings2.append({
                'symbol': sym,
                'name': str(s.get('stocName', '')).strip(),
                'shares': int(s.get('share', 0) or 0),
                'weight': float(s.get('weightRound') or s.get('weight') or 0),
            })

        hist_path2 = DATA_DIR / 'etf_00992a_history.json'
        hist2 = load_json(hist_path2)
        hist2[date2] = {
            'aum': aum2,
            'holdings_raw': holdings2,
        }
        save_json(hist_path2, hist2)
        print(f"  Saved {date2} → {hist_path2}")
    else:
        print(f"  API error: {body}")
except Exception as e:
    print(f"  FAILED: {e}")

print()
print("Done.")
