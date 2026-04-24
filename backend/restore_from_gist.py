"""Overwrite local alm_config.json with Gist's content (force restore)."""
import json, urllib.request, sys, shutil
from datetime import datetime
sys.stdout.reconfigure(encoding='utf-8')

LOCAL_PATH = r'E:\claude_money\backend\data\alm_config.json'

env = {}
with open(r'E:\claude_money\backend\.env') as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()

gist_id = env.get('GIST_ID', '')
token   = env.get('GITHUB_TOKEN', '')

req = urllib.request.Request(
    f'https://api.github.com/gists/{gist_id}',
    headers={'Authorization': f'token {token}', 'Accept': 'application/vnd.github.v3+json'}
)
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())

gist_content = data['files']['alm_config.json']['content']
gist_cfg = json.loads(gist_content)

# Backup local first
shutil.copy(LOCAL_PATH, LOCAL_PATH + '.bak')
print(f"Backed up local to {LOCAL_PATH}.bak")

# Write Gist content to local
with open(LOCAL_PATH, 'w', encoding='utf-8') as f:
    f.write(gist_content)

print(f"Restored from Gist (_last_modified: {gist_cfg.get('_last_modified')})")

# Verify
with open(LOCAL_PATH, encoding='utf-8') as f:
    local = json.load(f)
for g in local.get('investments', []):
    if g['group'] == '股票':
        print(f"\n股票 positions ({len(g['items'])} 檔):")
        for item in g['items']:
            print(f"  {item.get('symbol')} {item.get('name')}  shares={item.get('shares')}  cost={item.get('cost')}")
