# kindle-library

Answer "have I already read this author on Kindle?" — covers both owned books
and Kindle Unlimited borrows (including returned ones).

Amazon has no official API for your personal library, so this drives a real
browser session with Playwright:

- **Owned/active books** come from the internal JSON endpoint behind
  `read.amazon.com/kindle-library`.
- **Kindle Unlimited borrows (current + returned)** come from the
  Content & Devices (`/hz/mycd`) ajax endpoint, filtered to KindleUnlimited.

## Usage

```sh
uv run kindle.py login                 # one-time: real browser window, log in + 2FA
uv run kindle.py sync                  # pull everything into data/books.json
uv run kindle.py author "sanderson"    # query by author (case-insensitive substring)
```

Re-run `sync` whenever you want fresh data.

## Caveats

- Your Amazon session lives in `browser-profile/` (gitignored). Treat it like
  a password; delete the directory to log out.
- Amazon only retains KU borrow history for your **current** subscription
  stretch — if you cancelled and re-subscribed, older borrows are gone from
  the site. The only recovery is Amazon's **Account → Request My Data**
  export, which also includes per-book reading sessions.
- "In my library" ≈ "read" only if you finish what you acquire. Reading
  progress is not exposed by these endpoints.
- Raw API responses land in `data/raw/` for debugging if Amazon changes the
  endpoint shapes.
