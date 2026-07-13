const { app, BrowserWindow, ipcMain, session, net } = require('electron')
const path = require('path')
const fs = require('fs')

const PARTITION = 'persist:amazon'
// A plain-Chrome UA: Electron's default advertises "Electron/", which Amazon may treat differently.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

const LIBRARY_URL = 'https://read.amazon.com/kindle-library'
const SEARCH_URL = 'https://read.amazon.com/kindle-library/search'
const MYCD_URL = 'https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc'
const AJAX_URL = 'https://www.amazon.com/hz/mycd/ajax'

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

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method, session: ses(), useSessionCookies: true })
    req.setHeader('User-Agent', USER_AGENT)
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function notLoggedIn() {
  const e = new Error('not logged in')
  e.code = 'NOT_LOGGED_IN'
  return e
}

// Amazon redirects unauthenticated JSON requests to an HTML sign-in page,
// so "response isn't JSON" is our logged-out signal.
async function fetchJson(url, opts) {
  const res = await request(url, opts)
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

async function fetchKuBorrows(progress) {
  const page = await request(MYCD_URL)
  const m = page.text.match(/csrfToken\s*[=:]\s*["']([^"']+)["']/)
  if (!m) {
    saveRaw('mycd_page.html', page.text)
    throw notLoggedIn()
  }
  const csrf = m[1]

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
          originType: ['KindleUnlimited'],
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
    progress(`Kindle Unlimited: ${items.length} borrows…`)
    if (!got.length || !data.hasMoreItems) return items
  }
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const cleanAuthor = (a) => decodeEntities(a).replace(/:$/, '').trim()

function splitAuthors(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(cleanAuthor).filter(Boolean)
  if (typeof value === 'string') return value.split(/[;:]/).map(cleanAuthor).filter(Boolean)
  return []
}

function kuAuthors(it) {
  const fromDetails = (it.bookProducerDetails || [])
    .filter((d) => d.role === 'author')
    .map((d) => cleanAuthor(d.name))
    .filter(Boolean)
  return fromDetails.length ? fromDetails : splitAuthors(it.authors)
}

function mergeBooks(owned, ku) {
  const books = new Map()
  for (const it of owned) {
    books.set(it.asin, {
      asin: it.asin,
      title: decodeEntities(it.title) || '(untitled)',
      authors: splitAuthors(it.authors),
      sources: [it.originType === 'KINDLE_UNLIMITED' ? 'ku-active' : 'owned'],
    })
  }
  for (const it of ku) {
    const status = it.lendingStatus === 'OnLoan' ? 'ku-active' : 'ku-returned'
    const cur = books.get(it.asin) || {
      asin: it.asin,
      title: decodeEntities(it.title) || '(untitled)',
      authors: kuAuthors(it),
      sources: [],
    }
    if (!cur.sources.includes(status)) cur.sources.push(status)
    if (it.acquiredDate) cur.acquiredDate = it.acquiredDate
    books.set(it.asin, cur)
  }
  return [...books.values()].sort((a, b) => a.title.localeCompare(b.title))
}

function send(state) {
  console.log('[sync]', JSON.stringify(state).slice(0, 300))
  if (win && !win.isDestroyed()) win.webContents.send('sync-state', state)
}

async function doSync() {
  if (syncing) return
  syncing = true
  send({ state: 'syncing', detail: 'starting…' })
  try {
    const owned = await fetchOwned((d) => send({ state: 'syncing', detail: d }))
    const ku = await fetchKuBorrows((d) => send({ state: 'syncing', detail: d }))
    const payload = {
      syncedAt: new Date().toISOString(),
      counts: { owned: owned.length, ku: ku.length },
      books: mergeBooks(owned, ku),
    }
    fs.writeFileSync(dataFile(), JSON.stringify(payload, null, 1))
    send({ state: 'done', ...payload })
  } catch (e) {
    if (e.code === 'NOT_LOGGED_IN') send({ state: 'needs-login' })
    else send({ state: 'error', message: String(e.message || e) })
  } finally {
    syncing = false
  }
}

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

  // Probe a cheap endpoint until the session is authenticated, then resync.
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

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 760,
    title: 'Kindle Shelf',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

ipcMain.handle('books:get', () => {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'))
  } catch {
    return null
  }
})
ipcMain.handle('sync', () => { doSync() })
ipcMain.handle('login:open', () => { openLogin() })

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
