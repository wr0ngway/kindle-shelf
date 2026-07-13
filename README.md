# Kindle Shelf

Answer "have I already read this author on Kindle?" — covers owned books **and**
Kindle Unlimited borrows, including returned ones.

Amazon has no official API for your personal library, so this is a small
Electron app: the embedded browser is where you sign in to Amazon (session
persists inside the app), and syncs hit Amazon's internal JSON endpoints
through the app's own Chromium network stack:

- **Owned/active books** — the endpoint behind `read.amazon.com/kindle-library`.
- **KU borrows (current + returned)** — the Content & Devices (`/hz/mycd`)
  ajax endpoint, filtered to KindleUnlimited.

Catalog data (series contents, author catalogs, product details) comes from
Amazon HTML pages fetched through a hidden window in the same session —
a bare HTTP client trips Amazon's bot verification; a real renderer doesn't.

## Usage

```sh
npm start
```

- First launch: click **Sign in to Amazon**, log in (2FA included) in the
  embedded window. It closes itself once the session works, then syncs.
- Every launch auto-syncs, so data stays fresh; **↻ Refresh** re-syncs on
  demand mid-session.

**Library tab** — search by author/title; *Group by series* toggle
(series inferred from titles, refined by product metadata as it's cached).
Badges: *Owned*, *Kindle Unlimited* (active borrow), *KU · returned*,
reading progress.

**Author drill-down** — click any author name to fetch their full Kindle
catalog, grouped by series, with read/unread badges. Filters: *Unread only*,
*Released only*. If the search mixes several same-named authors, chips let
you pick the one you meant.

**Continue Series tab** — every series you've read, most recently acquired
first. *Check for new books* (or *Scan unchecked series*) fetches the series
page and lists unread volumes — with *Released only* on by default so
pre-orders don't clutter the list. Results cache for a week; ↻ re-checks.

**Book details** — click any book row: cover, synopsis, rating, reviews,
release date, and **📖 Read with Kindle** (opens the book in an embedded
Kindle Cloud Reader window) or **View on Amazon**.

Data, caches, and the Amazon session live under
`~/Library/Application Support/kindle-shelf/` (`books.json`, `cache/`,
`raw/` for debugging). Delete the directory to log out / reset.

## Dev helpers

`probe.js` and `test-parse.js` run one-off fetches/parses against the live
session (`npx electron probe.js`) — useful when Amazon changes page shapes.

## Caveats

- Amazon only retains KU borrow history for your **current** subscription
  stretch — if you cancelled and re-subscribed, older borrows are gone from
  the site. The only recovery is Amazon's **Account → Request My Data**
  export, which also includes per-book reading sessions.
- "In my library / borrowed" ≈ "read" only if you finish what you acquire;
  reading progress isn't exposed by these endpoints.
- The endpoints are unofficial and could change shape — raw responses in
  `raw/` make re-adapting easy.
