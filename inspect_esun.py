import re

with open("esun.html", "r", encoding="utf-8", errors="ignore") as f:
    text = f.read()

# search iframe
iframes = re.findall(r'<iframe[^>]+src=["\']([^"\']+)["\']', text, re.IGNORECASE)
print('Iframes:', iframes)
