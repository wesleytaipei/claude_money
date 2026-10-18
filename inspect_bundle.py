with open("bundle.js", "r", encoding="utf-8", errors="ignore") as f:
    text = f.read()

import re
# check how webpack imports chunks: /b2brwd/page/js/
m = re.findall(r'["\'](/b2brwd/page/js/[^"\']+)["\']', text)
print('js urls in bundle:', set(m))
m2 = re.findall(r'\.src\s*=\s*[^;]+', text)
print('src assignments:', m2[:5])
