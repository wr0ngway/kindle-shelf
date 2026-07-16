const { app, BrowserWindow, ipcMain, session, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const QRCode = require('qrcode')
const {
  createAmazon, decodeEntities, splitAuthors, guessSeries, seriesKey, USER_AGENT,
} = require('./lib/amazon')
const { createRemoteServer } = require('./lib/server')
const tailscale = require('./lib/tailscale')

// Same data dir in dev and packaged builds (packaged would otherwise derive
// it from the product name "Kindle Shelf"), so session + caches carry over.
app.setPath('userData', path.join(app.getPath('appData'), 'kindle-shelf'))

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
let remoteHandle = null

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

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  if (remoteHandle) remoteHandle.broadcast(channel, payload)
}

function send(state) {
  console.log('[sync]', JSON.stringify(state).slice(0, 300))
  broadcast('sync-state', state)
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
    startScan() // fills in / refreshes series data in the background
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

// ---------- background series scan ----------
// Runs after every successful sync: checks any series without fresh cached
// data (first launch = everything), newest acquisitions first, throttled by
// the shared page-fetch queue.

let scanning = false
let scanStopRequested = false

function sendScan(evt) {
  broadcast('scan-state', evt)
}

async function startScan() {
  if (scanning) return
  scanning = true
  scanStopRequested = false
  try {
    const queue = computeSeriesGroups().filter((g) => !g.check)
    const total = queue.length
    if (!total) {
      sendScan({ state: 'idle', message: 'all series checked' })
      return
    }
    console.log(`[scan] ${total} unchecked series`)
    sendScan({ state: 'scanning', done: 0, total })
    let done = 0
    for (const g of queue) {
      if (scanStopRequested) break
      let check = null
      try {
        check = await checkSeries(g.key)
      } catch (e) {
        console.log('[scan] failed:', g.name, String(e.message || e))
      }
      done++
      sendScan({ state: 'scanning', done, total, name: g.name, key: g.key, check })
    }
    console.log(`[scan] ${scanStopRequested ? 'stopped' : 'finished'} (${done}/${total})`)
    sendScan({ state: 'idle', done, total, stopped: scanStopRequested })
  } finally {
    scanning = false
  }
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
  // Close hides instead of quitting so the remote server stays up
  // (always-on); really quit via the tray menu, Cmd+Q, or app menu.
  win.on('close', (e) => {
    if (!quitting && !SMOKE) {
      e.preventDefault()
      win.hide()
    }
  })
}

// ---------- tray / background mode ----------

let tray = null
let quitting = false

const backgroundSettings = () => ({ startAtLogin: false, hideDock: false, ...(loadSettings().background || {}) })
function saveBackground(patch) {
  const s = loadSettings()
  s.background = { ...backgroundSettings(), ...patch }
  saveSettings(s)
}

function setLinuxAutostart(enable) {
  const dir = path.join(os.homedir(), '.config', 'autostart')
  const file = path.join(dir, 'kindle-shelf.desktop')
  if (!enable) {
    try { fs.unlinkSync(file) } catch {}
    return
  }
  fs.mkdirSync(dir, { recursive: true })
  const exec = process.env.APPIMAGE || process.execPath
  fs.writeFileSync(file,
    `[Desktop Entry]\nType=Application\nName=Kindle Shelf\nExec="${exec}"\nX-GNOME-Autostart-enabled=true\n`)
}

function startAtLoginEnabled() {
  if (process.platform === 'linux') return backgroundSettings().startAtLogin
  return app.getLoginItemSettings().openAtLogin
}

function setStartAtLogin(enable) {
  if (process.platform === 'linux') setLinuxAutostart(enable)
  else app.setLoginItemSettings({ openAtLogin: enable })
  saveBackground({ startAtLogin: enable })
}

function applyDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return
  if (backgroundSettings().hideDock) app.dock.hide()
  else app.dock.show()
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  else {
    win.show()
    win.focus()
  }
}

function refreshTray() {
  if (!tray) return
  const remoteOn = Boolean(remoteHandle)
  const items = [
    { label: 'Open Kindle Shelf', click: showWindow },
    { label: 'Sync now', click: () => doSync() },
    { label: remoteOn ? '📱 Remote access: on' : '📱 Remote access: off', enabled: false },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: startAtLoginEnabled(),
      click: (item) => { setStartAtLogin(item.checked); refreshTray() },
    },
  ]
  if (process.platform === 'darwin')
    items.push({
      label: 'Hide Dock icon',
      type: 'checkbox',
      checked: backgroundSettings().hideDock,
      click: (item) => { saveBackground({ hideDock: item.checked }); applyDockVisibility(); refreshTray() },
    })
  items.push({ type: 'separator' }, {
    label: 'Quit Kindle Shelf',
    click: () => { quitting = true; app.quit() },
  })
  tray.setToolTip(`Kindle Shelf${remoteOn ? ' — remote access on' : ''}`)
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function createTray() {
  const icons = path.join(__dirname, 'renderer', 'icons')
  const icon = process.platform === 'darwin'
    ? path.join(icons, 'trayTemplate.png') // 'Template' name → auto dark/light adaption
    : nativeImage.createFromPath(path.join(icons, 'icon-192.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  refreshTray()
}

// ---------- ipc ----------

async function applyOverride(asin, value) {
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
}

async function getDetailsPayload(asin, opts = {}) {
  const meta = await getMeta(asin, opts)
  const data = loadBooks()
  const book = (data?.books || []).find((b) => b.asin === asin) || null
  const ov = loadOverrides()[asin] || null
  return {
    meta,
    book,
    override: ov,
    read: effectiveRead(Boolean(book), book?.amazonReadStatus === 'READ', ov),
  }
}

// ---------- remote access ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}
function saveSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 1))
}

// Same UI + API, served over HTTP for phones/browsers. Login stays desktop-only.
const remoteApi = {
  'GET /api/books': () => annotateBooks(loadBooks()),
  'GET /api/version': () => ({ version: app.getVersion() }),
  'POST /api/sync': () => { doSync(); return { ok: true } },
  'POST /api/scan-start': () => { startScan(); return { ok: true } },
  'POST /api/scan-stop': () => { scanStopRequested = true; return { ok: true } },
  'GET /api/details': ({ query }) =>
    getDetailsPayload(query.get('asin'), { force: query.get('force') === '1' }),
  'GET /api/series-groups': () => computeSeriesGroups(),
  'POST /api/series-check': ({ body }) => checkSeries(body.key, { force: Boolean(body.force) }),
  'POST /api/author': ({ body }) => authorCatalog(body.name, { force: Boolean(body.force) }),
  'POST /api/override': ({ body }) => applyOverride(body.asin, body.value ?? null),
}

async function startRemote() {
  if (remoteHandle) return
  const s = loadSettings()
  s.remote = s.remote || {}
  s.remote.token = s.remote.token || crypto.randomBytes(16).toString('hex')
  s.remote.port = s.remote.port || 8787
  s.remote.enabled = true
  saveSettings(s)
  remoteHandle = await createRemoteServer({
    port: s.remote.port,
    staticDir: path.join(__dirname, 'renderer'),
    getToken: () => loadSettings().remote?.token,
    api: remoteApi,
    log: (m) => console.log('[remote]', m),
  })
}

function stopRemote() {
  if (remoteHandle) remoteHandle.close()
  remoteHandle = null
  const s = loadSettings()
  if (s.remote) s.remote.enabled = false
  saveSettings(s)
}

function lanIp() {
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254')) continue
      const [x, y] = a.address.split('.').map(Number)
      if (x === 100 && y >= 64 && y <= 127) continue // tailscale CGNAT range
      return a.address
    }
  return null
}

async function remoteStatus() {
  const s = loadSettings()
  const enabled = Boolean(remoteHandle)
  const ts = await tailscale.status()
  const running = ts.state === 'running'
  const port = s.remote?.port || 8787
  const serveActive = enabled && running ? await tailscale.serveActive(port) : false

  const urls = []
  if (enabled) {
    if (serveActive && ts.dnsName) urls.push({ label: 'Tailscale HTTPS', url: `https://${ts.dnsName}` })
    if (running && ts.ip) urls.push({ label: 'Tailscale', url: `http://${ts.ip}:${port}` })
    const lan = lanIp()
    if (lan) urls.push({ label: 'Wi-Fi (LAN)', url: `http://${lan}:${port}` })
    for (const u of urls)
      u.qr = await QRCode.toDataURL(`${u.url}/?token=${s.remote.token}`, { width: 300, margin: 1 })
  }

  const phoneStore = {}
  if (enabled)
    for (const [os_, url] of Object.entries(tailscale.PHONE_STORE_URLS))
      phoneStore[os_] = { url, qr: await QRCode.toDataURL(url, { width: 220, margin: 1 }) }

  return {
    enabled,
    port,
    token: s.remote?.token || null,
    urls,
    tailscale: {
      ...ts,
      serveActive,
      platform: process.platform,
      downloadUrl: tailscale.downloadUrl(),
    },
    phoneStore,
  }
}

ipcMain.handle('books:get', () => annotateBooks(loadBooks()))
ipcMain.handle('version:get', () => app.getVersion())
ipcMain.handle('override:set', (_e, asin, value) => applyOverride(asin, value))
ipcMain.handle('remote:status', () => remoteStatus())
ipcMain.handle('remote:set', async (_e, enabled) => {
  if (enabled) await startRemote()
  else stopRemote()
  refreshTray()
  return remoteStatus()
})
ipcMain.handle('remote:regen', () => {
  const s = loadSettings()
  s.remote = s.remote || {}
  s.remote.token = crypto.randomBytes(16).toString('hex')
  saveSettings(s)
  return remoteStatus()
})
ipcMain.handle('remote:tailscale', async (_e, enable) => {
  try {
    const s = loadSettings()
    if (enable) await tailscale.enableServe(s.remote?.port || 8787)
    else await tailscale.disableServe()
    return await remoteStatus()
  } catch (e) {
    if (e.enableUrl) {
      shell.openExternal(e.enableUrl)
      return {
        error:
          'One-time approval needed — a browser page just opened ("Start using Serve").\n\n' +
          'On that page:\n' +
          '  •  Keep "HTTPS certificates" checked.\n' +
          '  •  "Tailscale Funnel" is optional — Kindle Shelf never uses it and stays ' +
          'tailnet-only either way, so uncheck it unless you want it for other things.\n\n' +
          'Click Enable there, then press this button again.',
      }
    }
    let error = String(e.message || e)
    if (/cert|https|magicdns/i.test(error))
      error += ' — enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS tab), then retry.'
    return { error }
  }
})
ipcMain.handle('sync', () => { doSync() })
ipcMain.handle('login:open', () => { openLogin() })
ipcMain.handle('reader:open', (_e, asin) => { openReader(asin) })
ipcMain.handle('external:open', (_e, url) => {
  if (/^https:\/\/((www|read|smile)\.amazon\.com|tailscale\.com)\//.test(url)) shell.openExternal(url)
})
ipcMain.handle('details:get', (_e, asin, opts) => getDetailsPayload(asin, opts || {}))
ipcMain.handle('series:groups', () => computeSeriesGroups())
ipcMain.handle('scan:start', () => { startScan() })
ipcMain.handle('scan:stop', () => { scanStopRequested = true })
ipcMain.handle('series:check', (_e, key, opts) => checkSeries(key, opts || {}))
ipcMain.handle('author:catalog', (_e, name, opts) => authorCatalog(name, opts || {}))

app.whenReady().then(() => {
  ses().setUserAgent(USER_AGENT)
  createWindow()
  if (!SMOKE) {
    createTray()
    applyDockVisibility()
    if (loadSettings().remote?.enabled)
      startRemote()
        .then(refreshTray)
        .catch((e) => console.log('[remote] failed to start:', String(e.message || e)))
  }

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

// Keep running in the background (tray + remote server) when windows close;
// quit only via tray menu / Cmd+Q.
app.on('window-all-closed', () => {
  if (SMOKE) app.quit()
})
app.on('before-quit', () => { quitting = true })
app.on('activate', () => showWindow())
