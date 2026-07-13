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

## Usage

```sh
npm start
```

- First launch: click **Sign in to Amazon**, log in (2FA included) in the
  embedded window. It closes itself once the session works, then syncs.
- Every launch auto-syncs, so data stays fresh; **↻ Refresh** re-syncs on
  demand mid-session.
- Type an author (or title) in the search box — matches show badges for
  *Owned*, *Kindle Unlimited* (active borrow), or *KU · returned*.

Data and the Amazon session live under Electron's userData directory
(`~/Library/Application Support/kindle-shelf/`): `books.json`, `raw/` (raw API
responses, for debugging), and the session partition. Delete the directory to
log out / reset.

## CLI (legacy)

`kindle.py` is the original Playwright CLI version of the same sync
(`uv run kindle.py login|sync|author`). The app supersedes it.

## Caveats

- Amazon only retains KU borrow history for your **current** subscription
  stretch — if you cancelled and re-subscribed, older borrows are gone from
  the site. The only recovery is Amazon's **Account → Request My Data**
  export, which also includes per-book reading sessions.
- "In my library / borrowed" ≈ "read" only if you finish what you acquire;
  reading progress isn't exposed by these endpoints.
- The endpoints are unofficial and could change shape — raw responses in
  `raw/` make re-adapting easy.
