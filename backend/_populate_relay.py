"""One-shot: from a Taiwan IP, fetch the 3 TWSE 上市 figures and push them to the
Gist as last-good relay files so Railway (whose IP is blocked by TWSE) can serve
them immediately. Throwaway helper — safe to delete after running."""
import os, re, json, time
from datetime import datetime
import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
GIST_ID = os.getenv("GIST_ID")
TOKEN = os.getenv("GITHUB_TOKEN")
assert GIST_ID and TOKEN, "missing gist creds"

UA = {"User-Agent": "Mozilla/5.0"}
_TS = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_twse_date(raw: str) -> str:
    raw = (raw or "").strip()
    if re.match(r"^\d{8}$", raw):
        return raw
    m = re.match(r"^(\d{3})/(\d{2})/(\d{2})$", raw)
    if m:
        return f"{int(m.group(1))+1911}{m.group(2)}{m.group(3)}"
    m = re.match(r"^(\d{3})(\d{2})(\d{2})$", raw)
    if m:
        return f"{int(m.group(1))+1911}{m.group(2)}{m.group(3)}"
    return ""


def fetch_ranking(n=25):
    # mirror main._fetch_twse_turnover_ranking
    r = requests.get(
        "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json",
        headers=UA, timeout=20)
    d = json.loads(r.content.decode("utf-8"))
    trade_date = _parse_twse_date(d.get("date", ""))
    out = []
    for row in d.get("data") or []:
        code = str(row[0]).strip()
        if not re.match(r"^[1-9]\d{3}$", code):
            continue
        try:
            turnover = int(str(row[3]).replace(",", ""))
            close = float(str(row[7]).replace(",", "")) if row[7] not in ("--", "") else None
            chg = float(str(row[8]).replace(",", "").replace("+", "")) if row[8] not in ("--", "", "X", "除息", "除權") else None
            name = str(row[1]).strip()
            prev_close = round(close - chg, 2) if close is not None and chg is not None else None
            chg_pct = round(chg / prev_close * 100, 2) if prev_close and prev_close > 0 else None
            out.append({"code": code, "name": name, "turnover": turnover,
                        "close": close, "chg": chg, "chg_pct": chg_pct})
        except Exception:
            continue
    out.sort(key=lambda x: x["turnover"], reverse=True)
    return out[:n], trade_date


def main():
    import info_scraper as isc
    files = {}

    twse, trade_date = fetch_ranking(25)
    print(f"ranking: {len(twse)} items, date={trade_date}")
    if twse:
        files["turnover_twse_lastgood.json"] = {
            "twse": twse, "trade_date": trade_date, "_last_modified": _TS}

    mb = isc.fetch_twse_margin(force=True)
    print("margin balance:", mb)
    if mb.get("balance") is not None:
        files["margin_tse_lastgood.json"] = {
            "balance": mb["balance"], "increase": mb.get("increase"), "_last_modified": _TS}

    tr = isc.fetch_taiex_margin_ratio()
    print("margin ratio:", tr)
    if tr.get("current") is not None:
        files["margin_ratio_tse_lastgood.json"] = {
            "current": tr["current"], "prev": tr.get("prev"), "_last_modified": _TS}

    if not files:
        print("nothing to push"); return

    payload = {"files": {name: {"content": json.dumps(c, ensure_ascii=False, indent=2)}
                         for name, c in files.items()}}
    r = requests.patch(f"https://api.github.com/gists/{GIST_ID}",
                       headers={"Authorization": f"token {TOKEN}",
                                "Accept": "application/vnd.github.v3+json"},
                       json=payload, timeout=20)
    print("gist push status:", r.status_code, "| pushed:", list(files.keys()))


if __name__ == "__main__":
    main()
