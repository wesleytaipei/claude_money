import os
import requests
import json
from dotenv import load_dotenv

load_dotenv()

GIST_ID = os.getenv("GIST_ID")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

print(f"DEBUG: GIST_ID = {GIST_ID}")
print(f"DEBUG: TOKEN  = {GITHUB_TOKEN[:10]}...")

def test_gist_push():
    url = f"https://api.github.com/gists/{GIST_ID}"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    payload = {
        "files": {
            "test_sync.json": {
                "content": json.dumps({"status": "success", "msg": "Sync is working!"})
            }
        }
    }
    r = requests.patch(url, headers=headers, json=payload)
    if r.status_code == 200:
        print("✅ Gist 同步測試成功！")
    else:
        print(f"❌ 同步失敗。錯誤代碼: {r.status_code}")
        print(f"錯誤訊息: {r.text}")

if __name__ == "__main__":
    test_gist_push()
