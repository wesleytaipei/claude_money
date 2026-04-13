import re

htmls = [
    '<meta property="og:title" content="和淞(6826.TWO) 561.00 (-6.10%) | Yahoo股市" />',
    '<meta property="og:title" content="加權指數(^TWII) 20000.00 (+1.50%) | Yahoo股市" />'
]

for html in htmls:
    # Option A: find all bracketed stuff
    res = re.findall(r'\(([-+%\d.]+)\)', html)
    print(f"Brakets in {html[:30]}: {res}")
    if res:
        print(f"  Last: {res[-1]}")

    # Option B: greedy match to skip the first one
    m = re.search(r'og:title" content=".*\(.*\).*?\(([-+%\d.]+)\)', html)
    if m:
        print(f"  Greedy match: {m.group(1)}")
