const { app, BrowserWindow, ipcMain, session, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const {
  createAmazon, decodeEntities, splitAuthors, guessSeries, seriesKey, USER_AGENT,
} = require('./lib/amazon')

const PARTITION = 'persist:amazon'
const LIBRARY_URL = 'https://read.amazon.com/kindle-library'
const SEARCH_URL = 'https://read.amazon.com/kindle-library/search'
const MYCD_URL = 'https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc'
const AJAX_URL = 'https://www.amazon.com/hz/mycd/ajax'

const DAY = 24 * 60 * 60 * 1000
const SMOKE = process.argv.includes('--smoke')

let win = null
let loginWin = null
let loginPoll = null
let syncing = false

const ses = () => session.fromPartition(PARTITION)
const dataFile = () => path.join(app.getPath('userData'), 'books.json')
const rawDir = () => path.join(app.getPath('userData'), 'raw')

function saveRaw(name, text) {
  fs.mkdirSync(rawDir(), { recursive: true })
  fs.writeFileSync(path.join(rawDir(), name), text)
}

const amazon = createAmazon({
  getSession: ses,
  saveRaw,
  log: (m) => console.log('[amazon]', m),
})

// ---------- cache ----------

function cachePath(kind, key) {
  const safe = String(key).toLowerCase().replace(/[^a-z0-9._-]/gi, '_').slice(0, 120)
  return path.join(app.getPath('userData'), 'cache', kind, `${safe}.json`)
}
function readCache(kind, key, maxAge) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(kind, key), 'utf8'))
    if (Date.now() - j.fetchedAt < maxAge) return j.value
  } catch {}
  return null
}
function writeCache(kind, key, value) {
  const p = cachePath(kind, key)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), value }))
}
function allCached(kind, maxAge) {
  const dir = path.join(app.getPath('userData'), 'cache', kind)
  const out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
      if (Date.now() - j.fetchedAt < maxAge) out.push(j.value)
    } catch {}
  }
  return out
}

// ---------- sync (library + KU) ----------

function notLoggedIn() {
  const e = new Error('not logged in')
  e.code = 'NOT_LOGGED_IN'
  return e
}

async function fetchJson(url, opts) {
  const res = await amazon.rawRequest(url, opts)
  try {
    return JSON.parse(res.text)
  } catch {
    saveRaw('last_non_json_response.html', res.text)
    throw notLoggedIn()
  }
}

async function fetchOwned(progress) {
  const items = []
  let token = null
  for (let batch = 0; ; batch++) {
    let qs = 'query=&libraryType=BOOKS&sortType=acquisition_desc&querySize=50'
    if (token) qs += `&paginationToken=${encodeURIComponent(token)}`
    const payload = await fetchJson(`${SEARCH_URL}?${qs}`)
    saveRaw(`library_batch_${batch}.json`, JSON.stringify(payload, null, 2))
    const got = payload.itemsList || []
    items.push(...got)
    progress(`library: ${items.length} books…`)
    token = payload.paginationToken
    if (!token || !got.length) return items
  }
}

let mycdCsrf = null
async function getMycdCsrf(force = false) {
  if (mycdCsrf && !force) return mycdCsrf
  const page = await amazon.rawRequest(MYCD_URL)
  const m = page.text.match(/csrfToken\s*[=:]\s*["']([^"']+)["']/)
  if (!m) {
    saveRaw('mycd_page.html', page.text)
    throw notLoggedIn()
  }
  mycdCsrf = m[1]
  return mycdCsrf
}

// All ebooks Amazon knows about (purchases + KU borrows incl. returned),
// with per-item readStatus — the record behind "Mark as read".
async function fetchMycdBooks(progress) {
  const csrf = await getMycdCsrf(true)

  const items = []
  const batchSize = 100
  for (let batch = 0; ; batch++) {
    const param = {
      param: {
        OwnershipData: {
          sortOrder: 'DESCENDING',
          sortIndex: 'DATE',
          startIndex: batch * batchSize,
          batchSize,
          contentType: 'Ebook',
          itemStatus: ['Active', 'Expired'],
        },
      },
    }
    const body = new URLSearchParams({ data: JSON.stringify(param), csrfToken: csrf }).toString()
    const payload = await fetchJson(AJAX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    saveRaw(`ku_batch_${batch}.json`, JSON.stringify(payload, null, 2))
    const data = payload.OwnershipData || {}
    if (data.success === false) throw new Error(`OwnershipData request failed — see raw/ku_batch_${batch}.json`)
    const got = data.items || []
    items.push(...got)
    progress(`Amazon records: ${items.length} books…`)
    if (!got.length || !data.hasMoreItems) return items
  }
}

function kuAuthors(it) {
  const fromDetails = (it.bookProducerDetails || [])
    .filter((d) => d.role === 'author')
    .map((d) => decodeEntities(d.name).trim())
    .filter(Boolean)
  return fromDetails.length ? fromDetails : splitAuthors(it.authors)
}

function mergeBooks(owned, mycdItems) {
  const ku = mycdItems.filter((it) => it.originType === 'Ku' || it.lendingType === 'KU')
  const readStatusByAsin = new Map(
    mycdItems.filter((it) => it.originType !== 'Sample').map((it) => [it.asin, it.readStatus]))

  const books = new Map()
  owned.forEach((it, i) => {
    books.set(it.asin, {
      asin: it.asin,
      title: decodeEntities(it.title) || '(untitled)',
      authors: splitAuthors(it.authors),
      sources: [it.originType === 'KINDLE_UNLIMITED' ? 'ku-active' : 'owned'],
      percentageRead: it.percentageRead ?? null,
      cover: it.productUrl || null,
      recency: i / Math.max(owned.length, 1), // 0 = most recently acquired
    })
  })
  ku.forEach((it, i) => {
    const status = it.lendingStatus === 'OnLoan' ? 'ku-active' : 'ku-returned'
    const cur = books.get(it.asin) || {
      asin: it.asin,
      title: decodeEntities(it.title) || '(untitled)',
      authors: kuAuthors(it),
      sources: [],
      percentageRead: null,
      cover: it.productImage || null,
      recency: 1,
    }
    if (!cur.sources.includes(status)) cur.sources.push(status)
    if (it.acquiredDate) cur.acquiredDate = it.acquiredDate
    cur.recency = Math.min(cur.recency, i / Math.max(ku.length, 1))
    books.set(it.asin, cur)
  })
  const list = [...books.values()].sort((a, b) => a.title.localeCompare(b.title))
  for (const b of list) {
    b.amazonReadStatus = readStatusByAsin.get(b.asin) || null
    const g = guessSeries(b.title)
    if (g) {
      b.seriesGuess = g.name
      b.seriesNum = g.num
      b.seriesKey = seriesKey(g.name)
    }
  }
  return list
}

function send(state) {
  console.log('[sync]', JSON.stringify(state).slice(0, 300))
  if (win && !win.isDestroyed()) win.webContents.send('sync-state', state)
}

function loadBooks() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'))
  } catch {
    return null
  }
}

// Manual read/unread overrides: asin -> 'read' | 'unread'. Fixes books read
// outside the synced history (or borrowed but never actually read).
const overridesFile = () => path.join(app.getPath('userData'), 'overrides.json')
function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(overridesFile(), 'utf8'))
  } catch {
    return {}
  }
}
function setOverride(asin, value) {
  const ov = loadOverrides()
  if (value) ov[asin] = value
  else delete ov[asin]
  fs.writeFileSync(overridesFile(), JSON.stringify(ov, null, 1))
  return ov
}
// Push a read/unread mark to Amazon itself (same record the Kindle apps and
// Content & Devices use). Throws if Amazon rejects it.
async function updateAmazonReadState(asin, read, retry = true) {
  const csrf = await getMycdCsrf()
  const body = new URLSearchParams({
    data: JSON.stringify({
      param: {
        UpdateReadState: {
          asinDetails: { [asin]: { category: 'KindleEBook' } },
          operation: read ? 'MarkAsRead' : 'MarkAsUnread',
        },
      },
    }),
    csrfToken: csrf,
    clientId: 'MYCD_WebService',
  }).toString()
  const payload = await fetchJson(AJAX_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const r = payload.UpdateReadState || {}
  if (!(r.success && r.resultMap && r.resultMap[asin])) {
    if (retry) {
      // Stale csrf token is the common transient failure — refresh once.
      await getMycdCsrf(true)
      return updateAmazonReadState(asin, read, false)
    }
    saveRaw('update_read_state.json', JSON.stringify(payload, null, 2))
    throw new Error('Amazon rejected the read-state update (book may not be in your Amazon library)')
  }
}

// Effective read status. Amazon is the source of truth for books it knows
// about; the local override only covers what Amazon can't represent:
// books never acquired there, and the explicit-unread state (Amazon's
// "unread" is just UNKNOWN, indistinguishable from never-marked).
function effectiveRead(inLibrary, amazonRead, override) {
  if (!inLibrary) return override === 'read'
  if (amazonRead) return true
  return override !== 'unread'
}

function annotateBooks(data) {
  if (!data) return data
  const ov = loadOverrides()
  for (const b of data.books || []) {
    b.readOverride = ov[b.asin] || null
    b.amazonRead = b.amazonReadStatus === 'READ'
    b.read = effectiveRead(true, b.amazonRead, b.readOverride)
  }
  return data
}

// After each sync, drop local overrides that Amazon's record supersedes:
// a READ mark upstream beats any local mark, and a 'read' override on a
// library book is redundant (presence already means read).
function pruneOverrides(books) {
  const ov = loadOverrides()
  const byAsin = new Map(books.map((b) => [b.asin, b]))
  let changed = false
  for (const [asin, value] of Object.entries(ov)) {
    const b = byAsin.get(asin)
    if (!b) continue
    if (b.amazonReadStatus === 'READ' || value === 'read') {
      delete ov[asin]
      changed = true
    }
  }
  if (changed) fs.writeFileSync(overridesFile(), JSON.stringify(ov, null, 1))
}

async function doSync() {
  if (syncing) return
  syncing = true
  send({ state: 'syncing', detail: 'starting…' })
  try {
    const owned = await fetchOwned((d) => send({ state: 'syncing', detail: d }))
    const mycdItems = await fetchMycdBooks((d) => send({ state: 'syncing', detail: d }))
    const books = mergeBooks(owned, mycdItems)
    const payload = {
      syncedAt: new Date().toISOString(),
      counts: {
        owned: owned.length,
        ku: books.filter((b) => b.sources.some((s) => s.startsWith('ku'))).length,
      },
      books,
    }
    fs.writeFileSync(dataFile(), JSON.stringify(payload, null, 1))
    pruneOverrides(books)
    send({ state: 'done', ...annotateBooks(payload) })
  } catch (e) {
    if (e.code === 'NOT_LOGGED_IN') send({ state: 'needs-login' })
    else send({ state: 'error', message: String(e.message || e) })
  } finally {
    syncing = false
  }
}

// ---------- product metadata / details ----------

async function getMeta(asin, { force = false, maxAge = 30 * DAY } = {}) {
  if (!force) {
    const hit = readCache('meta', asin, maxAge)
    if (hit) return hit
  }
  const meta = await amazon.fetchProductMeta(asin)
  writeCache('meta', asin, meta)
  return meta
}

// ---------- series groups ----------

function computeSeriesGroups() {
  const data = loadBooks()
  if (!data) return []
  const metaByAsin = new Map(allCached('meta', 365 * DAY).map((m) => [m.asin, m]))
  const groups = new Map()
  for (const b of data.books) {
    const meta = metaByAsin.get(b.asin)
    const name = meta?.series?.name || b.seriesGuess
    if (!name) continue
    const key = seriesKey(name)
    const g = groups.get(key) || {
      key, name, books: [], recency: 1, seriesAsin: null, total: null,
    }
    g.books.push({
      asin: b.asin, title: b.title, num: meta?.series?.num ?? b.seriesNum ?? null,
      sources: b.sources, percentageRead: b.percentageRead,
    })
    if (meta?.series?.asin) g.seriesAsin = meta.series.asin
    if (meta?.series?.total) g.total = meta.series.total
    if (meta?.series?.name) g.name = meta.series.name
    g.recency = Math.min(g.recency, b.recency)
    groups.set(key, g)
  }
  const out = [...groups.values()]
  for (const g of out) {
    g.books.sort((a, b) => (a.num ?? 99) - (b.num ?? 99))
    g.check = annotateVolumes(readCache('series-check', g.key, 7 * DAY))
  }
  out.sort((a, b) => a.recency - b.recency)
  return out
}

// Re-annotate cached series volumes against the *current* library + overrides.
function annotateVolumes(check) {
  if (!check || !check.volumes) return check
  const byAsin = new Map((loadBooks()?.books || []).map((b) => [b.asin, b]))
  const ov = loadOverrides()
  for (const v of check.volumes) {
    const mine = v.asin ? byAsin.get(v.asin) : null
    v.inLibrary = Boolean(mine) || v.purchased
    v.read = effectiveRead(v.inLibrary, mine?.amazonReadStatus === 'READ', ov[v.asin])
  }
  return check
}

async function checkSeries(key, { force = false } = {}) {
  if (!force) {
    const hit = readCache('series-check', key, 7 * DAY)
    if (hit) return annotateVolumes(hit)
  }
  const groups = computeSeriesGroups()
  const g = groups.find((x) => x.key === key)
  if (!g) throw new Error(`unknown series ${key}`)

  // Resolve the series ASIN via a member book's product page if needed.
  let seriesAsin = g.seriesAsin
  if (!seriesAsin) {
    for (const b of g.books.slice(0, 2)) {
      const meta = await getMeta(b.asin)
      if (meta.series?.asin) {
        seriesAsin = meta.series.asin
        break
      }
    }
  }
  let result
  if (!seriesAsin) {
    result = { key, unresolved: true, checkedAt: new Date().toISOString() }
  } else {
    const page = await amazon.fetchSeriesPage(seriesAsin)
    result = { key, seriesAsin, ...page, checkedAt: new Date().toISOString() }
  }
  writeCache('series-check', key, result)
  return annotateVolumes(result)
}

// ---------- author catalog ----------

function annotateCatalog(result) {
  const byAsin = new Map((loadBooks()?.books || []).map((b) => [b.asin, b]))
  const ov = loadOverrides()
  for (const c of result.items || []) {
    const mine = byAsin.get(c.asin)
    c.inLibrary = Boolean(mine)
    c.mySources = mine ? mine.sources : []
    c.read = effectiveRead(c.inLibrary, mine?.amazonReadStatus === 'READ', ov[c.asin])
  }
  return result
}

async function authorCatalog(name, { force = false } = {}) {
  const cacheKey = name.toLowerCase()
  if (!force) {
    const hit = readCache('authors', cacheKey, 1 * DAY)
    if (hit) return annotateCatalog(hit)
  }
  const cards = await amazon.searchKindleStore(`"${name}"`, { maxPages: 3, tag: 'author' })
  const result = { name, fetchedAt: new Date().toISOString(), items: cards }
  writeCache('authors', cacheKey, result)
  return annotateCatalog(result)
}

// ---------- windows ----------

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus()
    return
  }
  loginWin = new BrowserWindow({
    width: 1100,
    height: 820,
    parent: win,
    title: 'Sign in to Amazon',
    webPreferences: { partition: PARTITION },
  })
  loginWin.loadURL(LIBRARY_URL)
  loginPoll = setInterval(async () => {
    try {
      await fetchJson(`${SEARCH_URL}?query=&libraryType=BOOKS&querySize=1`)
    } catch {
      return
    }
    clearInterval(loginPoll)
    loginPoll = null
    if (loginWin && !loginWin.isDestroyed()) loginWin.close()
    doSync()
  }, 3000)
  loginWin.on('closed', () => {
    loginWin = null
    if (loginPoll) clearInterval(loginPoll)
    loginPoll = null
  })
}

function openReader(asin) {
  const reader = new BrowserWindow({
    width: 1100,
    height: 900,
    title: 'Kindle Reader',
    webPreferences: { partition: PARTITION },
  })
  reader.loadURL(`https://read.amazon.com/?asin=${encodeURIComponent(asin)}`)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1150,
    height: 820,
    title: 'Kindle Shelf',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

// ---------- ipc ----------

ipcMain.handle('books:get', () => annotateBooks(loadBooks()))
ipcMain.handle('override:set', async (_e, asin, value) => {
  if (![null, 'read', 'unread'].includes(value)) throw new Error('bad override value')
  const data = loadBooks()
  const book = (data?.books || []).find((b) => b.asin === asin) || null
  let amazonSynced = false
  let amazonError = null

  if (value) {
    try {
      await updateAmazonReadState(asin, value === 'read')
      amazonSynced = true
      if (book) {
        // Reflect Amazon's new state locally without waiting for a re-sync.
        book.amazonReadStatus = value === 'read' ? 'READ' : 'UNKNOWN'
        fs.writeFileSync(dataFile(), JSON.stringify(data, null, 1))
      }
    } catch (e) {
      amazonError = String(e.message || e)
    }
  }

  // Store locally only what Amazon's record can't carry.
  if (value === 'read') {
    // Library book successfully marked upstream: Amazon holds the truth.
    setOverride(asin, book && amazonSynced ? null : 'read')
  } else if (value === 'unread') {
    // Amazon has no explicit unread state — keep it locally for library
    // books; for non-library books unread just clears the local read mark.
    setOverride(asin, book ? 'unread' : null)
  } else {
    setOverride(asin, null)
  }
  return { amazonSynced, amazonError }
})
ipcMain.handle('sync', () => { doSync() })
ipcMain.handle('login:open', () => { openLogin() })
ipcMain.handle('reader:open', (_e, asin) => { openReader(asin) })
ipcMain.handle('external:open', (_e, url) => {
  if (/^https:\/\/(www|read|smile)\.amazon\.com\//.test(url)) shell.openExternal(url)
})
ipcMain.handle('details:get', async (_e, asin, opts) => {
  const meta = await getMeta(asin, opts || {})
  const data = loadBooks()
  const book = (data?.books || []).find((b) => b.asin === asin) || null
  const ov = loadOverrides()[asin] || null
  return {
    meta,
    book,
    override: ov,
    read: effectiveRead(Boolean(book), book?.amazonReadStatus === 'READ', ov),
  }
})
ipcMain.handle('series:groups', () => computeSeriesGroups())
ipcMain.handle('series:check', (_e, key, opts) => checkSeries(key, opts || {}))
ipcMain.handle('author:catalog', (_e, name, opts) => authorCatalog(name, opts || {}))

app.whenReady().then(() => {
  ses().setUserAgent(USER_AGENT)
  createWindow()

  if (SMOKE) {
    const errors = []
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) errors.push(message)
    })
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        console.log(errors.length ? `SMOKE FAIL:\n${errors.join('\n')}` : 'SMOKE OK')
        app.exit(errors.length ? 1 : 0)
      }, 2000)
    })
  } else {
    win.webContents.on('did-finish-load', () => doSync())
  }
})

app.on('window-all-closed', () => app.quit())
