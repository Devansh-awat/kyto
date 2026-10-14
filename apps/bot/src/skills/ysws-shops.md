---
name: ysws-shops
description: Find which Hack Club YSWS programs offer which prizes or shop items — rank programs by shipped projects, crawl their shop/prize pages, and build a cached, greppable item index. Use for "which YSWS has a 3D printer", "what's in the YSWS shops", "top N YSWS and their prizes".
---

# YSWS shops

Never hand-type an item list: every item in the answer must come from a page the crawl saved.

1. If `ysws-shops/<today>/index.csv` already exists in the sandbox, skip to step 3 — the cache answers follow-ups with a grep.
2. Write the crawler and run it (stdlib only; ~1-2 min for 50 programs). `--top N` takes the N programs with the most shipped projects (`ships.hackclub.com/api/v1/ysws_entries`, the popularity ranking — "top 50" means this, not start date); `--all` ranks every program ever (396), not just the active ones.

```bash
cat > ysws_shops.py <<'PY'
"""Which YSWS programs offer which prizes: rank, crawl, cache, index.

python3 ysws_shops.py [--top 50] [--all] [--out ysws-shops]
Then: grep -ril "3d printer" ysws-shops/<date>/pages
"""

import argparse
import collections
import concurrent.futures
import csv
import datetime
import html
import json
import os
import re
import urllib.parse
import urllib.request

SHIPS = "https://ships.hackclub.com/api/v1/ysws_entries"
PROGRAMS = "https://events-api.hackclub.dev/api/programs"
SHOP_WORDS = re.compile(r"shop|prize|reward|store|market|bazaar|redeem|catalog", re.I)
FIXED_PATHS = ["/shop", "/prizes", "/rewards", "/store"]
LOGIN_WORDS = re.compile(r"\b(sign in|log in|login|sign up with slack|continue with slack)\b", re.I)
# Word boundaries matter: a bare "ram" matches "program".
VOCAB = [
    "3d printer", "bambu", "prusa", "raspberry pi", "arduino", "esp32", "pico",
    "framework laptop", "laptop", "macbook", "ipad", "tablet", "kindle",
    "steam deck", "nintendo switch", "switch 2", "playstation", "xbox", "game boy",
    "keyboard", "mechanical keyboard", "mouse", "monitor", "headphones",
    "airpods", "earbuds", "speaker", "microphone", "webcam", "camera",
    "soldering iron", "pinecil", "multimeter", "oscilloscope", "flipper zero",
    "ssd", "ram", "gpu", "graphics card", "cpu", "drone", "vr headset", "quest",
    "smartwatch", "phone", "hoodie", "t-shirt", "shirt", "sticker", "socks",
    "domain", "hosting", "server credits", "cloud credits", "github copilot",
    "jetbrains", "figma", "grant", "gift card", "amazon", "flight", "travel stipend",
]
VOCAB_RE = [(item, re.compile(r"\b" + re.escape(item) + r"s?\b", re.I)) for item in VOCAB]


def get(url, timeout=15, cap=3_000_000):
    request = urllib.request.Request(url, headers={"User-Agent": "kyto-ysws-shops"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read(cap).decode("utf-8", "replace")


def text_of(page):
    page = re.sub(r"<(script|style|noscript|svg)\b[\s\S]*?</\1>", "", page, flags=re.I)
    page = re.sub(r"<br\s*/?>|</(p|div|h[1-6]|li|tr)>", "\n", page, flags=re.I)
    page = html.unescape(re.sub(r"<[^>]+>", " ", page))
    return re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t]+", " ", page)).strip()


def crawl(program, folder):
    site = (program.get("Website URL") or "").strip()
    row = {"program": program["Name"], "ships": program["ships"], "website": site,
           "status": "", "pages": 0, "items": "", "shop_urls": ""}
    if not site.startswith("http"):
        row["status"] = "no website"
        return row
    try:
        _, home = get(site)
    except Exception as error:
        row["status"] = f"not responding ({type(error).__name__})"
        return row
    host = urllib.parse.urlparse(site).netloc
    links = []
    for href, label in re.findall(r'<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)</a>', home, re.I):
        url = urllib.parse.urljoin(site, href)
        if urllib.parse.urlparse(url).netloc == host and (SHOP_WORDS.search(href) or SHOP_WORDS.search(text_of(label))):
            links.append(url)
    links += [urllib.parse.urljoin(site, path) for path in FIXED_PATHS]
    pages = {site: home}
    for url in list(dict.fromkeys(links))[:12]:
        try:
            status, body = get(url, timeout=10)
            if status == 200:
                pages[url] = body
        except Exception:
            pass
    os.makedirs(folder, exist_ok=True)
    found, shop_urls, texts = collections.Counter(), [], []
    for index, (url, body) in enumerate(pages.items()):
        text = text_of(body)
        texts.append(text)
        with open(os.path.join(folder, f"{index}.txt"), "w") as handle:
            handle.write(f"{url}\n\n{text}")
        if url != site:
            shop_urls.append(url)
        for item, pattern in VOCAB_RE:
            if pattern.search(text):
                found[item] += 1
    total = sum(len(text) for text in texts)
    row["pages"] = len(pages)
    row["shop_urls"] = " ".join(shop_urls)
    row["items"] = ", ".join(sorted(found))
    if found:
        row["status"] = "items found"
    elif total < 600:
        row["status"] = "client-rendered (no text without a browser)"
    elif any(LOGIN_WORDS.search(text) for text in texts) and not shop_urls:
        row["status"] = "login-gated"
    else:
        row["status"] = "no shop or prize text found"
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--top", type=int, default=50)
    parser.add_argument("--all", action="store_true", help="every program, not just active ones")
    parser.add_argument("--out", default="ysws-shops")
    args = parser.parse_args()
    out = os.path.join(args.out, datetime.date.today().isoformat())
    ships = collections.Counter(entry.get("ysws") for entry in json.loads(get(SHIPS, 60, cap=None)[1]))
    programs = json.loads(get(PROGRAMS + ("" if args.all else "/active"), 30)[1])["data"]
    for program in programs:
        program["ships"] = ships.get(program.get("Name"), 0)
    ranked = sorted(programs, key=lambda program: -program["ships"])[: args.top]
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(
            lambda program: crawl(program, os.path.join(out, "pages", re.sub(r"\W+", "-", program["Name"]).strip("-").lower())),
            ranked,
        ))
    columns = ["program", "ships", "status", "items", "website", "shop_urls", "pages"]
    with open(os.path.join(out, "index.csv"), "w", newline="") as handle:
        writer = csv.DictWriter(handle, columns)
        writer.writeheader()
        writer.writerows(rows)
    with open(os.path.join(out, "index.md"), "w") as handle:
        handle.write("| program | ships | status | items |\n|---|---|---|---|\n")
        for row in rows:
            handle.write(f"| [{row['program']}]({row['website']}) | {row['ships']} | {row['status']} | {row['items']} |\n")
    print(json.dumps({
        "folder": out,
        "programs": len(rows),
        "status": collections.Counter(row["status"].split(" (")[0] for row in rows),
    }, indent=1))


if __name__ == "__main__":
    main()
PY
python3 ysws_shops.py --top 50
```

3. Answer from the files:
   - `ysws-shops/<date>/index.csv` / `index.md`: program, ships, status, matched items, shop URLs.
   - A specific item: `grep -ril "3d printer" ysws-shops/<date>/pages` — then read the matching file to quote the real line (the vocabulary match only says the words appear; "grant" may be the program's funding, not a prize).
   - An item not in the vocabulary: grep the pages for it — every page's text is saved.
4. `client-rendered` rows are JavaScript shops with no text in the HTML: `fetchUrl` on their shop URL (it renders through a reader) before calling them empty. `login-gated` and `not responding` are reported as such, never guessed.
5. Hand over `index.md` (or the CSV) as a file when asked for one, and say how many programs had items, how many were client-rendered, gated or down.
