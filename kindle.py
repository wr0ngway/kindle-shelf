"""Query your Kindle library — owned books and Kindle Unlimited borrows — by author.

Usage:
    uv run kindle.py login              # one-time: log into Amazon in a real browser window
    uv run kindle.py sync               # pull library + KU borrow history into data/
    uv run kindle.py author "Sanderson" # who's read what: match books by author

No API credentials exist for this; everything rides on your own logged-in
browser session, persisted in ./browser-profile (gitignored).
"""

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
PROFILE_DIR = ROOT / "browser-profile"
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"

LIBRARY_URL = "https://read.amazon.com/kindle-library"
LIBRARY_SEARCH_URL = "https://read.amazon.com/kindle-library/search"
MYCD_URL = "https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc"
MYCD_AJAX_URL = "https://www.amazon.com/hz/mycd/ajax"


def browser_context(p, headless):
    return p.chromium.launch_persistent_context(
        str(PROFILE_DIR),
        headless=headless,
        viewport={"width": 1280, "height": 900},
    )


def cmd_login():
    with sync_playwright() as p:
        ctx = browser_context(p, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(LIBRARY_URL)
        print("A browser window is open. Log into Amazon (including 2FA) until")
        print("you can see your Kindle library at read.amazon.com.")
        input("Then come back here and press Enter to save the session... ")
        ctx.close()
    print("Session saved to browser-profile/. Now run: uv run kindle.py sync")


def fetch_owned_library(page):
    """Page through read.amazon.com's internal library-search JSON endpoint."""
    page.goto(LIBRARY_URL, wait_until="domcontentloaded")
    if "signin" in page.url or "/ap/" in page.url:
        sys.exit("Not logged in (redirected to sign-in). Run: uv run kindle.py login")
    page.wait_for_timeout(3000)

    items, token, batch = [], None, 0
    while True:
        params = "query=&libraryType=BOOKS&sortType=acquisition_desc&querySize=50"
        if token:
            params += f"&paginationToken={token}"
        resp = page.request.get(f"{LIBRARY_SEARCH_URL}?{params}")
        if not resp.ok:
            sys.exit(f"Library endpoint returned HTTP {resp.status} — see data/raw/ for context")
        payload = resp.json()
        (RAW_DIR / f"library_batch_{batch}.json").write_text(json.dumps(payload, indent=2))
        got = payload.get("itemsList", [])
        items.extend(got)
        print(f"  library: {len(items)} items...")
        token = payload.get("paginationToken")
        if not token or not got:
            return items
        batch += 1
        time.sleep(0.5)


def mycd_csrf_token(page):
    page.goto(MYCD_URL, wait_until="domcontentloaded")
    if "signin" in page.url or "/ap/" in page.url:
        sys.exit("Not logged in on amazon.com. Run: uv run kindle.py login")
    page.wait_for_timeout(3000)
    token = page.evaluate(
        """() => window.csrfToken
            || document.querySelector('input[name=csrfToken]')?.value
            || (document.documentElement.outerHTML.match(/csrfToken\\s*[=:]\\s*["']([^"']+)["']/) || [])[1]
            || null"""
    )
    if not token:
        (RAW_DIR / "mycd_page.html").write_text(page.content())
        sys.exit("Couldn't find csrfToken on Content & Devices page; page HTML saved to data/raw/mycd_page.html")
    return token


def fetch_ku_borrows(page):
    """Pull Kindle Unlimited borrows (current AND returned) from the
    Content & Devices GetContentOwnershipData ajax endpoint."""
    token = mycd_csrf_token(page)
    items, batch = [], 0
    while True:
        param = {
            "GetContentOwnershipData": {
                "contentType": "Ebook",
                "contentCategoryReference": "booksAll",
                "itemStatusList": ["Active", "Expired"],
                "originTypes": ["KindleUnlimited"],
                "showSharedContent": True,
                "fetchCriteria": {"sortOrder": "DESCENDING", "sortIndex": "DATE",
                                  "startIndex": batch * 100, "batchSize": 100,
                                  "totalContentCount": -1},
                "surfaceType": "LargeDesktop",
            }
        }
        resp = page.request.post(
            MYCD_AJAX_URL,
            form={"data": json.dumps(param), "csrfToken": token},
        )
        if not resp.ok:
            sys.exit(f"mycd ajax returned HTTP {resp.status}")
        payload = resp.json()
        (RAW_DIR / f"ku_batch_{batch}.json").write_text(json.dumps(payload, indent=2))
        data = payload.get("GetContentOwnershipData", {})
        if not data.get("success", True) and not data.get("items"):
            sys.exit(f"mycd ajax unhappy — inspect data/raw/ku_batch_{batch}.json")
        got = data.get("items", [])
        items.extend(got)
        print(f"  KU borrows: {len(items)} items...")
        if len(items) >= data.get("numberOfItems", 0) or not got:
            return items
        batch += 1
        time.sleep(0.5)


def cmd_sync():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        ctx = browser_context(p, headless=True)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        print("Fetching owned/active library from read.amazon.com ...")
        owned = fetch_owned_library(page)
        print("Fetching Kindle Unlimited borrow history from amazon.com ...")
        ku = fetch_ku_borrows(page)
        ctx.close()

    books = {}
    for it in owned:
        asin = it.get("asin")
        books[asin] = {
            "asin": asin,
            "title": it.get("title"),
            "authors": [a.strip() for a in it.get("authors", []) if a and a.strip()],
            "originType": it.get("originType"),
            "sources": ["library"],
        }
    for it in ku:
        asin = it.get("asin")
        status = "returned" if it.get("isDeleted") or it.get("status") == "Expired" else "borrowed"
        entry = books.setdefault(asin, {
            "asin": asin,
            "title": it.get("title"),
            "authors": [a.strip() for a in (it.get("authors") or "").split(",") if a.strip()],
            "sources": [],
        })
        entry["sources"].append(f"kindle-unlimited ({status})")
        entry["acquiredDate"] = it.get("acquiredDate")

    out = DATA_DIR / "books.json"
    out.write_text(json.dumps(sorted(books.values(), key=lambda b: b["title"] or ""), indent=2))
    print(f"\nSaved {len(books)} books ({len(owned)} library, {len(ku)} KU borrows) to {out}")


def cmd_author(name):
    path = DATA_DIR / "books.json"
    if not path.exists():
        sys.exit("No data yet. Run: uv run kindle.py sync")
    needle = name.lower()
    hits = [b for b in json.loads(path.read_text())
            if any(needle in a.lower() for a in b["authors"])]
    if not hits:
        print(f"No books found for author matching {name!r}.")
        return
    for b in hits:
        authors = ", ".join(b["authors"])
        print(f"{b['title']}\n    by {authors}  [{'; '.join(b['sources'])}]")
    print(f"\n{len(hits)} book(s) matching author {name!r}.")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login", help="log into Amazon once in a visible browser")
    sub.add_parser("sync", help="pull library + KU borrows into data/")
    a = sub.add_parser("author", help="list synced books matching an author")
    a.add_argument("name")
    args = ap.parse_args()
    if args.cmd == "login":
        cmd_login()
    elif args.cmd == "sync":
        cmd_sync()
    else:
        cmd_author(args.name)


if __name__ == "__main__":
    main()
