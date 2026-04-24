import json, urllib.request, sys
sys.stdout.reconfigure(encoding='utf-8')

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

content = data['files']['alm_config.json']['content']
cfg = json.loads(content)

print(f"Gist _last_modified: {cfg.get('_last_modified')}")
print()

for g in cfg.get('investments', []):
    if g['group'] == '股票':
        print(f"=== GIST 股票 ({len(g['items'])} 檔) ===")
        for item in g['items']:
            sym   = item.get('symbol', '?')
            name  = item.get('name', '?')
            shr   = item.get('shares', '?')
            cost  = item.get('cost', '?')
            marg  = item.get('margin_amount', 0)
            print(f"  {sym} {name}  shares={shr}  cost={cost}  margin={marg}")
        print()

print("=== LOCAL 股票 ===")
with open(r'E:\claude_money\backend\data\alm_config.json', encoding='utf-8') as f:
    local = json.load(f)

print(f"Local _last_modified: {local.get('_last_modified')}")
for g in local.get('investments', []):
    if g['group'] == '股票':
        print(f"({len(g['items'])} 檔)")
        for item in g['items']:
            sym   = item.get('symbol', '?')
            name  = item.get('name', '?')
            shr   = item.get('shares', '?')
            cost  = item.get('cost', '?')
            marg  = item.get('margin_amount', 0)
            print(f"  {sym} {name}  shares={shr}  cost={cost}  margin={marg}")
