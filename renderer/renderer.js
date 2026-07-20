const $ = (id) => document.getElementById(id)
const MAX_ROWS = 800
const BADGE_LABELS = {
  owned: 'Owned',
  'ku-active': 'Kindle Unlimited',
  'ku-returned': 'KU · returned',
  unread: 'Not read',
  preorder: 'Not yet released',
}

const state = {
  books: [],
  syncedAt: null,
  view: 'library',
  author: null, // {name, items, chip}
  seriesGroups: null,
  scanning: false,
  syncing: false,
  statusBase: '', // last sync summary, restored after transient messages
}

// One header button: refresh (sync → auto-scan) when idle, stop while scanning.
function refreshUi() {
  const btn = $('refresh')
  if (state.syncing) {
    btn.disabled = true
    btn.textContent = 'Syncing…'
  } else if (state.scanning) {
    btn.disabled = false
    btn.textContent = '■ Stop scan'
    btn.title = 'Stop the background series scan'
  } else {
    btn.disabled = false
    btn.textContent = '↻ Refresh'
    btn.title = 'Re-sync from Amazon (series scan follows automatically)'
  }
}

// ---------- persisted controls ----------

const PERSISTED_CONTROLS = ['lib-sort', 'group-series', 'lib-compact', 'lib-unread-only', 'lib-released-only']

function restoreControls() {
  for (const id of PERSISTED_CONTROLS) {
    const v = localStorage.getItem(`ctl:${id}`)
    if (v == null) continue
    const n = $(id)
    if (n.type === 'checkbox') n.checked = v === '1'
    else n.value = v
  }
}

function persistControls() {
  for (const id of PERSISTED_CONTROLS) {
    const n = $(id)
    localStorage.setItem(`ctl:${id}`, n.type === 'checkbox' ? (n.checked ? '1' : '0') : n.value)
  }
}

// ---------- helpers ----------

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function badge(kind, label) {
  return el('span', `badge ${kind}`, label || BADGE_LABELS[kind] || kind)
}

function setStatus(text) {
  $('status').textContent = text
}

function fmtSynced() {
  if (!state.syncedAt) return 'never synced'
  const mins = Math.round((Date.now() - new Date(state.syncedAt)) / 60000)
  return mins < 1 ? 'synced just now'
    : mins < 60 ? `synced ${mins}m ago`
    : `synced ${new Date(state.syncedAt).toLocaleString()}`
}

function authorLink(name) {
  const a = el('a', 'author-link', name)
  a.href = '#'
  a.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openAuthorView(name)
  })
  return a
}

// Toggle a read/unread mark (pushed to Amazon's own read-state record when
// the book exists there), then refresh whatever's on screen.
async function toggleRead(asin, currentlyRead) {
  const res = await window.kindle.setOverride(asin, currentlyRead ? 'unread' : 'read')
  await afterOverride()
  setStatus(res.amazonSynced
    ? `Marked ${currentlyRead ? 'unread' : 'read'} · synced to Amazon · ${fmtSynced()}`
    : `Marked ${currentlyRead ? 'unread' : 'read'} locally (Amazon: ${res.amazonError || 'not synced'}) · ${fmtSynced()}`)
}

async function afterOverride() {
  const data = await window.kindle.getBooks()
  if (data) {
    state.books = data.books || []
    state.syncedAt = data.syncedAt
  }
  if (state.seriesGroups) state.seriesGroups = await window.kindle.seriesGroups()
  if (state.author) {
    const cat = await window.kindle.authorCatalog(state.author.name)
    state.author.items = cat.items
  }
  if (state.view === 'author') renderAuthor()
  renderLibrary()
}

function markBtn(asin, read) {
  const b = el('button', 'mark-btn', read ? '↺ unread' : '✓ read')
  b.title = read ? 'Mark as not read' : 'Mark as read'
  b.addEventListener('click', async (e) => {
    e.stopPropagation()
    b.disabled = true
    await toggleRead(asin, read)
  })
  return b
}

function thumb(src) {
  const img = el('img', 'thumb')
  img.src = src
  img.loading = 'lazy'
  return img
}

function bookRow(b, { showAuthors = true, extraBadges = [] } = {}) {
  const li = el('div', 'row')
  if (b.cover) li.append(thumb(b.cover))
  li.append(el('span', 'title', b.title))
  if (showAuthors) {
    const span = el('span', 'authors')
    ;(b.authors || []).forEach((a, i) => {
      if (i) span.append(', ')
      span.append(authorLink(a))
    })
    li.append(span)
  } else {
    li.append(el('span', 'authors', ''))
  }
  if (b.releaseDate) li.append(el('span', 'date', b.releaseDate))
  if (b.percentageRead > 0 && b.percentageRead < 100)
    li.append(badge('progress', `${b.percentageRead}% read`))
  for (const s of b.sources || []) li.append(badge(s))
  if (b.amazonRead) li.append(badge('progress', '✓ Finished'))
  if (b.readOverride === 'unread' && b.read === false) li.append(badge('unread', 'Marked unread'))
  for (const x of extraBadges) li.append(x)
  li.addEventListener('click', () => openDetails(b.asin))
  return li
}

async function ensureSeriesGroups() {
  if (!state.seriesGroups) state.seriesGroups = await window.kindle.seriesGroups()
  return state.seriesGroups
}

function nextUnread(check, releasedOnly) {
  if (!check || check.unresolved) return null
  return (check.volumes || [])
    .filter((v) => !v.read && (!releasedOnly || v.released))
    .sort((a, b) => a.position - b.position)
}

// Compact row for an unread volume of a series.
function volumeRow(v) {
  const row = el('div', 'row next-row')
  if (v.cover) row.append(thumb(v.cover))
  row.append(el('span', 'title', `#${v.position}  ${v.title}`))
  row.append(el('span', 'authors',
    v.released ? (v.releaseDate ? `released ${v.releaseDate}` : '') : `releases ${v.releaseDate || 'TBA'}`))
  if (!v.released) row.append(badge('preorder'))
  if (v.kuAvailable) row.append(badge('ku-avail', 'On KU'))
  if (v.asin) {
    row.append(markBtn(v.asin, false))
    row.addEventListener('click', () => openDetails(v.asin))
  }
  return row
}

async function checkOne(g, opts) {
  try {
    g.check = await window.kindle.seriesCheck(g.key, opts)
  } catch (e) {
    g.check = null
    console.error('series check failed', g.name, e)
  }
}

function checkButton(g) {
  const btn = el('button', null, 'Check for new books')
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    btn.textContent = 'Checking…'
    btn.disabled = true
    await checkOne(g)
    renderLibrary()
  })
  return btn
}

// ---------- views ----------

function showView(name) {
  state.view = name
  $('view-library').classList.toggle('hidden', name !== 'library')
  $('view-author').classList.toggle('hidden', name !== 'author')
}

// ---------- library view ----------

function libraryMatches() {
  const q = $('search').value.trim().toLowerCase()
  if (!q) return state.books
  return state.books.filter(
    (b) =>
      (b.authors || []).some((a) => a.toLowerCase().includes(q)) ||
      b.title.toLowerCase().includes(q))
}

function renderLibrary() {
  persistControls()
  const grouped = $('group-series').checked
  for (const label of document.querySelectorAll('.needs-grouping')) {
    label.style.opacity = grouped ? 1 : 0.45
    label.querySelector('input').disabled = !grouped
  }

  const matches = libraryMatches()
  const wrap = $('lib-results')
  wrap.replaceChildren()
  if (grouped) {
    renderLibraryGrouped(wrap, matches)
  } else {
    const q = $('search').value.trim()
    $('lib-summary').textContent = q
      ? `${matches.length} of ${state.books.length} books match “${q}”`
      : `${state.books.length} books`
    const sorted = [...matches]
    if ($('lib-sort').value === 'recent') sorted.sort((a, b) => a.recency - b.recency)
    for (const b of sorted.slice(0, MAX_ROWS)) wrap.append(bookRow(b))
    if (sorted.length > MAX_ROWS)
      wrap.append(el('div', 'summary', `…and ${sorted.length - MAX_ROWS} more — narrow the search.`))
  }
}

function renderLibraryGrouped(wrap, matches) {
  const groups = state.seriesGroups
  if (!groups) {
    wrap.append(el('div', 'summary', 'Computing series…'))
    ensureSeriesGroups().then(renderLibrary)
    return
  }
  const q = $('search').value.trim().toLowerCase()
  const compact = $('lib-compact').checked
  const unreadOnly = $('lib-unread-only').checked
  const releasedOnly = $('lib-released-only').checked
  const recentFirst = $('lib-sort').value === 'recent'
  const matchAsins = new Set(matches.map((b) => b.asin))
  const byAsin = new Map(state.books.map((b) => [b.asin, b]))
  const groupedAsins = new Set()
  for (const g of groups) for (const b of g.books) groupedAsins.add(b.asin)

  const sorted = [...groups].sort(recentFirst
    ? (a, b) => a.recency - b.recency
    : (a, b) => a.name.localeCompare(b.name))

  let shown = 0
  let checked = 0
  for (const g of sorted) {
    if (g.check) checked++
    const members = g.books.map((b) => byAsin.get(b.asin)).filter(Boolean)
    const nameMatch = !q || (g.check?.name || g.name).toLowerCase().includes(q)
    if (!nameMatch && !members.some((b) => matchAsins.has(b.asin))) continue

    const next = nextUnread(g.check, releasedOnly)
    if (unreadOnly) {
      if (g.check?.unresolved) continue
      if (g.check && (!next || !next.length)) continue
    }

    const sec = el('div', 'series-group')
    const head = el('h3')
    const maxNum = Math.max(0, ...g.books.map((b) => b.num ?? 0))
    const total = g.check?.total || g.total
    head.append(`${g.check?.name || g.name}`)
    // Most common author among your books in the series, as a clickable byline.
    const counts = new Map()
    for (const m of members) for (const a of m.authors || []) counts.set(a, (counts.get(a) || 0) + 1)
    const topAuthor = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
    if (topAuthor) {
      head.append(' · by ')
      head.append(authorLink(topAuthor))
    }
    head.append(
      ` · ${members.length} read` +
      (maxNum ? ` · up to #${maxNum}` : '') +
      (total ? ` · ${total} in series` : ''))
    if (!g.check) {
      head.append(' ')
      head.append(checkButton(g))
    } else if (g.check.unresolved) {
      head.append(' ')
      head.append(el('span', null, 'series page not found'))
    } else {
      const btn = el('button', null, '↻')
      btn.title = 'Re-check this series now'
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        btn.disabled = true
        await checkOne(g, { force: true })
        renderLibrary()
      })
      head.append(' ')
      head.append(btn)
    }
    sec.append(head)

    if (!compact) for (const b of members) sec.append(bookRow(b))
    if (next && next.length) {
      for (const v of next.slice(0, 4)) sec.append(volumeRow(v))
      if (next.length > 4) sec.append(el('div', 'summary', `…and ${next.length - 4} more unread`))
    } else if (g.check && !g.check.unresolved) {
      sec.append(el('div', 'summary caught-up', '✓ caught up'))
    }
    wrap.append(sec)
    shown++
  }

  if (!unreadOnly && !compact) {
    const solo = matches.filter((b) => !groupedAsins.has(b.asin))
    if (solo.length) {
      const sec = el('div', 'series-group')
      sec.append(el('h3', null, `No series detected · ${solo.length}`))
      for (const b of solo.slice(0, MAX_ROWS)) sec.append(bookRow(b))
      wrap.append(sec)
    }
  }
  $('lib-summary').textContent =
    `${groups.length} series · ${checked} checked · showing ${shown}` + (q ? ` matching “${q}”` : '')
  if (!shown) wrap.append(el('div', 'summary', 'No series match the current filters.'))
}

// The scan runs in the main process, auto-started after each sync; events
// keep the view live and drive the header button/status line.
window.kindle.onScanState((s) => {
  if (s.state === 'scanning') {
    state.scanning = true
    setStatus(`Checking series ${s.done}/${s.total}${s.name ? ` · ${s.name}` : ''}`)
    if (s.key && s.check && state.seriesGroups) {
      const g = state.seriesGroups.find((x) => x.key === s.key)
      if (g) g.check = s.check
    }
    if (s.key && $('group-series').checked && state.view === 'library') renderLibrary()
  } else {
    state.scanning = false
    setStatus(state.statusBase || fmtSynced())
    if (state.seriesGroups)
      window.kindle.seriesGroups().then((g) => {
        state.seriesGroups = g
        if (state.view === 'library') renderLibrary()
      })
  }
  refreshUi()
})

// ---------- author view ----------

async function openAuthorView(name, { force = false } = {}) {
  showView('author')
  $('author-title').textContent = name
  $('author-chips').replaceChildren()
  $('author-results').replaceChildren()
  $('author-summary').textContent = 'Fetching catalog from Amazon…'
  state.author = { name, items: [], chip: null }
  try {
    const cat = await window.kindle.authorCatalog(name, { force })
    if (state.author?.name !== name) return
    state.author.items = cat.items
    renderAuthor()
  } catch (e) {
    $('author-summary').textContent = `Fetch failed: ${e.message || e}`
  }
}

function renderAuthor() {
  const { items, chip } = state.author
  const unreadOnly = $('author-unread-only').checked
  const releasedOnly = $('author-released-only').checked

  // Disambiguation chips: distinct byline author strings from the results.
  const counts = new Map()
  for (const it of items)
    for (const a of it.authors || []) counts.set(a, (counts.get(a) || 0) + 1)
  const chipWrap = $('author-chips')
  chipWrap.replaceChildren()
  if (counts.size > 1) {
    chipWrap.append(el('span', 'summary', 'Which author? '))
    const all = el('button', `chip ${chip == null ? 'active' : ''}`, `All (${items.length})`)
    all.addEventListener('click', () => { state.author.chip = null; renderAuthor() })
    chipWrap.append(all)
    for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const c = el('button', `chip ${chip === name ? 'active' : ''}`, `${name} (${n})`)
      c.addEventListener('click', () => { state.author.chip = name; renderAuthor() })
      chipWrap.append(c)
    }
  }

  let list = items
  if (chip) list = list.filter((it) => (it.authors || []).includes(chip))
  if (releasedOnly) list = list.filter((it) => it.released)
  if (unreadOnly) list = list.filter((it) => !it.read)
  const read = list.filter((it) => it.read).length
  $('author-summary').textContent =
    `${list.length} books · ${read} read · ${list.length - read} unread` +
    (releasedOnly ? '' : ' · includes unreleased')

  const groups = new Map()
  const solo = []
  for (const it of list) {
    if (it.series?.name) {
      const key = it.series.name.toLowerCase()
      const g = groups.get(key) || { name: it.series.name, total: it.series.total, books: [] }
      g.books.push(it)
      groups.set(key, g)
    } else solo.push(it)
  }
  const wrap = $('author-results')
  wrap.replaceChildren()
  const renderItem = (it) => {
    const extras = []
    if (!it.read) {
      extras.push(badge('unread'))
      extras.push(markBtn(it.asin, false))
    } else if (!it.inLibrary) {
      extras.push(badge('progress', 'Marked read'))
      extras.push(markBtn(it.asin, true))
    }
    if (!it.released) extras.push(badge('preorder', it.releaseDate ? `Releases ${it.releaseDate}` : 'Not yet released'))
    if (it.kuAvailable) extras.push(badge('ku-avail', 'On KU'))
    const row = bookRow(
      { ...it, sources: it.mySources, authors: it.authors },
      { showAuthors: true, extraBadges: extras })
    if (it.series) row.querySelector('.title').textContent =
      `${it.title}${it.series.num != null ? `  (#${it.series.num})` : ''}`
    return row
  }
  for (const g of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const sec = el('div', 'series-group')
    g.books.sort((x, y) => (x.series?.num ?? 99) - (y.series?.num ?? 99))
    const readN = g.books.filter((b) => b.read).length
    sec.append(el('h3', null, `${g.name} · ${readN}/${g.total ?? g.books.length} read`))
    for (const b of g.books) sec.append(renderItem(b))
    wrap.append(sec)
  }
  if (solo.length) {
    const sec = el('div', 'series-group')
    sec.append(el('h3', null, 'Standalone / other'))
    for (const b of solo) sec.append(renderItem(b))
    wrap.append(sec)
  }
  if (!list.length) wrap.append(el('div', 'summary', 'Nothing matches the current filters.'))
}

$('author-back').addEventListener('click', () => showView('library'))
$('author-refresh').addEventListener('click', () => state.author && openAuthorView(state.author.name, { force: true }))
$('author-unread-only').addEventListener('change', renderAuthor)
$('author-released-only').addEventListener('change', renderAuthor)

// ---------- details drawer ----------

async function openDetails(asin) {
  const panel = $('details')
  const body = $('details-body')
  panel.classList.remove('hidden')
  body.replaceChildren(el('div', 'summary', 'Loading details…'))
  let meta, book, read
  try {
    ;({ meta, book, read } = await window.kindle.getDetails(asin))
  } catch (e) {
    body.replaceChildren(el('div', 'summary', `Failed to load: ${e.message || e}`))
    return
  }
  body.replaceChildren()
  if (meta.cover || book?.cover) {
    const img = el('img', 'cover')
    img.src = meta.cover || book.cover
    body.append(img)
  }
  body.append(el('h2', null, meta.title || book?.title || asin))
  if (meta.authors?.length) {
    const by = el('div', 'byline')
    by.append('by ')
    meta.authors.forEach((a, i) => {
      if (i) by.append(', ')
      by.append(authorLink(a))
    })
    body.append(by)
  }
  if (meta.series?.name)
    body.append(el('div', 'summary',
      `Book ${meta.series.num ?? '?'} of ${meta.series.total ?? '?'}: ${meta.series.name}`))
  if (meta.rating)
    body.append(el('div', 'summary', `★ ${meta.rating} · ${meta.reviewCount || '?'} ratings`))
  if (meta.releaseDate) body.append(el('div', 'summary', `Published ${meta.releaseDate}`))

  const badges = el('div', 'badges')
  for (const s of book?.sources || []) badges.append(badge(s))
  if (book?.amazonRead || book?.amazonReadStatus === 'READ') badges.append(badge('progress', '✓ Finished'))
  if (!read) badges.append(badge('unread'))
  else if (!book) badges.append(badge('progress', 'Marked read'))
  if (meta.kuAvailable) badges.append(badge('ku-avail', 'On KU'))
  if (meta.released === false) badges.append(badge('preorder'))
  body.append(badges)

  const actions = el('div', 'actions')
  const canRead = book && book.sources.some((s) => s === 'owned' || s === 'ku-active')
  if (canRead) {
    const readBtn = el('button', 'primary', '📖 Read with Kindle')
    readBtn.addEventListener('click', () => window.kindle.openReader(asin))
    actions.append(readBtn)
  }
  const amz = el('button', null, canRead ? 'View on Amazon' : meta.kuAvailable ? 'Borrow / view on Amazon' : 'View on Amazon')
  amz.addEventListener('click', () => window.kindle.openExternal(`https://www.amazon.com/dp/${asin}`))
  actions.append(amz)
  const mark = el('button', null, read ? 'Mark as not read' : 'Mark as read')
  mark.addEventListener('click', async () => {
    mark.disabled = true
    await toggleRead(asin, read)
    openDetails(asin)
  })
  actions.append(mark)
  const reload = el('button', null, '↻')
  reload.title = 'Refresh details from Amazon'
  reload.addEventListener('click', () => {
    window.kindle.getDetails(asin, { force: true }).then(() => openDetails(asin))
  })
  actions.append(reload)
  body.append(actions)

  if (meta.description?.length) {
    body.append(el('h3', null, 'Synopsis'))
    for (const p of meta.description.slice(0, 12)) body.append(el('p', null, p))
  }
  if (meta.reviews?.length) {
    body.append(el('h3', null, 'Reviews'))
    for (const r of meta.reviews) {
      if (!r.body && !r.title) continue
      const rev = el('div', 'review')
      rev.append(el('div', 'review-head',
        `${r.stars ? `★ ${r.stars} · ` : ''}${r.title || ''} — ${r.name || 'anonymous'}${r.date ? ` · ${r.date}` : ''}`))
      rev.append(el('p', null, r.body))
      body.append(rev)
    }
  }
}

$('details-close').addEventListener('click', () => $('details').classList.add('hidden'))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('details').classList.add('hidden')
    closeRemotePanel()
  }
})

// ---------- remote access panel (desktop only) ----------

const remoteSupported = typeof window.kindle.remoteStatus === 'function'
if (!remoteSupported) $('remote-btn').classList.add('hidden')

function updateRemoteButton(st) {
  const btn = $('remote-btn')
  btn.classList.toggle('remote-on', st.enabled)
  btn.textContent = st.enabled ? '📱 On' : '📱'
  btn.title = st.enabled
    ? `Remote access is ON — ${(st.urls || []).map((u) => u.url).join('  ·  ') || 'no addresses found'}`
    : 'Remote access (phone)'
}

let remoteSelectedUrl = null

async function openRemotePanel() {
  const body = $('remote-body')
  $('remote-panel').classList.remove('hidden')
  if (!body.childElementCount) body.replaceChildren(el('div', 'summary', 'Loading…'))
  const st = await window.kindle.remoteStatus()
  updateRemoteButton(st)
  body.replaceChildren()
  body.append(el('h2', null, 'Remote access'))
  body.append(el('p', 'summary',
    'Serve this app to your phone’s browser. Access is gated by a token baked into the QR code; ' +
    'once scanned, the phone stays signed in.'))

  const toggle = el('button', st.enabled ? '' : 'primary',
    st.enabled ? 'Disable remote access' : 'Enable remote access')
  toggle.addEventListener('click', async () => {
    toggle.disabled = true
    await window.kindle.remoteSet(!st.enabled)
    openRemotePanel()
  })
  body.append(toggle)
  if (!st.enabled) return

  const urls = st.urls || []
  if (!urls.length) {
    body.append(el('p', 'summary', 'No reachable network addresses found.'))
  } else {
    const selected = urls.find((u) => u.url === remoteSelectedUrl) || urls[0]
    const chips = el('div', 'chips')
    for (const u of urls) {
      const c = el('button', `chip ${u.url === selected.url ? 'active' : ''}`, u.label)
      c.addEventListener('click', () => { remoteSelectedUrl = u.url; openRemotePanel() })
      chips.append(c)
    }
    body.append(chips)
    const qr = el('img', 'qr')
    qr.src = selected.qr
    body.append(qr)
    body.append(el('div', 'summary mono', selected.url))
  }

  body.append(el('h3', null, 'Phone setup'))
  body.append(el('p', 'summary',
    '1. Scan the QR (phone on the same Wi-Fi, or on your tailnet for the Tailscale addresses). ' +
    '2. The token is stored in the phone browser — no sign-in after that. ' +
    '3. Use “Add to Home Screen” for an app-like launch.'))

  body.append(el('h3', null, 'Tailscale — access from anywhere'))
  renderTailscaleSection(body, st)

  body.append(el('h3', null, 'Access token'))
  body.append(el('div', 'summary mono', st.token || '—'))
  const regen = el('button', null, 'Regenerate token')
  regen.title = 'Revokes access for every device that scanned the old QR'
  regen.addEventListener('click', async () => {
    regen.disabled = true
    await window.kindle.remoteRegen()
    openRemotePanel()
  })
  body.append(regen)

  // Auto-refresh while Tailscale setup is incomplete so steps tick off live.
  if (remotePoll) clearInterval(remotePoll)
  remotePoll = null
  if (st.enabled && st.tailscale?.state !== 'running')
    remotePoll = setInterval(() => {
      if ($('remote-panel').classList.contains('hidden')) closeRemotePanel()
      else openRemotePanel()
    }, 5000)
}

let remotePhoneOs = 'android'

function tsStep(n, done, label) {
  const row = el('div', `ts-step ${done ? 'done' : ''}`)
  row.append(el('span', 'ts-step-mark', done ? '✓' : `${n}.`))
  const content = el('span', 'ts-step-body')
  if (typeof label === 'string') content.append(label)
  else content.append(...label)
  row.append(content)
  return row
}

// Setup stepper when the tailnet isn't up yet; serve controls once it is.
function renderTailscaleSection(body, st) {
  const ts = st.tailscale || {}

  if (ts.state === 'running') {
    body.append(el('div', 'summary', `Connected: ${ts.dnsName || ts.ip}`))
    const btn = el('button', null, ts.serveActive
      ? 'Disable HTTPS address (tailscale serve)'
      : 'Enable HTTPS address (tailscale serve)')
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = 'Working…'
      const r = await window.kindle.remoteTailscale(!ts.serveActive)
      if (r?.error) alert(`Tailscale: ${r.error}`)
      openRemotePanel()
    })
    body.append(btn)
    body.append(el('p', 'summary',
      'Gives a stable https://…ts.net address reachable from anywhere on your tailnet ' +
      '(and only your tailnet), with a trusted certificate — required for full PWA install. ' +
      'First use opens a one-time approval page: keep “HTTPS certificates” checked; ' +
      '“Tailscale Funnel” is optional — Kindle Shelf never uses it and stays tailnet-only ' +
      'either way.'))
    return
  }

  body.append(el('p', 'summary',
    'The Wi-Fi address above only works at home. Tailscale (free for personal use) adds a ' +
    'private HTTPS address that works from anywhere — three steps:'))

  // Step 1: install on this computer
  const installed = Boolean(ts.installed)
  if (installed) {
    body.append(tsStep(1, true, 'Tailscale is installed on this computer'))
  } else {
    const dl = el('button', null, 'Download Tailscale')
    dl.addEventListener('click', () => window.kindle.openExternal(ts.downloadUrl))
    body.append(tsStep(1, false, ['Install Tailscale on this computer  ', dl]))
  }

  // Step 2: sign in on this computer
  const trayName = ts.platform === 'darwin' ? 'menu bar' : 'system tray'
  const signinText = ts.state === 'needs-login' || ts.state === 'stopped' || ts.state === 'error'
    ? `Open Tailscale from the ${trayName} and sign in — any Google, Apple, GitHub, or Microsoft account works`
    : ts.state === 'starting'
      ? 'Tailscale is starting…'
      : 'Sign in with any Google, Apple, GitHub, or Microsoft account'
  body.append(tsStep(2, false, signinText))

  // Step 3: phone app
  const phone = el('span', 'ts-step-body')
  phone.append('Install Tailscale on your phone and sign into the same account:  ')
  for (const os of ['android', 'ios']) {
    const c = el('button', `chip ${remotePhoneOs === os ? 'active' : ''}`, os === 'android' ? 'Android' : 'iPhone')
    c.addEventListener('click', () => { remotePhoneOs = os; openRemotePanel() })
    phone.append(c)
  }
  body.append(tsStep(3, false, [phone]))
  if (st.phoneStore?.[remotePhoneOs]) {
    const qr = el('img', 'qr qr-small')
    qr.src = st.phoneStore[remotePhoneOs].qr
    body.append(qr)
  }

  body.append(el('p', 'summary',
    'This panel updates automatically as each step completes. Once connected, an ' +
    '“Enable HTTPS” button appears here.'))
}

let remotePoll = null

function closeRemotePanel() {
  $('remote-panel').classList.add('hidden')
  if (remotePoll) clearInterval(remotePoll)
  remotePoll = null
}

if (remoteSupported) {
  $('remote-btn').addEventListener('click', openRemotePanel)
  $('remote-close').addEventListener('click', closeRemotePanel)
  window.kindle.remoteStatus().then(updateRemoteButton).catch(() => {})
}

// ---------- sync plumbing ----------

window.kindle.onSyncState((s) => {
  $('login-banner').classList.toggle('hidden', s.state !== 'needs-login')
  $('error-banner').classList.toggle('hidden', s.state !== 'error')
  state.syncing = s.state === 'syncing'
  if (s.state === 'syncing') setStatus(`Syncing — ${s.detail || ''}`)
  else if (s.state === 'needs-login') setStatus('Sign-in required')
  else if (s.state === 'error') {
    $('error-banner').textContent = `Sync failed: ${s.message}`
    setStatus(fmtSynced())
  } else if (s.state === 'done') {
    state.books = s.books || []
    state.syncedAt = s.syncedAt
    state.seriesGroups = null // recompute lazily
    renderLibrary()
    state.statusBase = `${s.counts.owned} library + ${s.counts.ku} KU · ${fmtSynced()}`
    setStatus(state.statusBase)
  }
  refreshUi()
})

$('search').addEventListener('input', renderLibrary)
$('lib-sort').addEventListener('change', renderLibrary)
$('group-series').addEventListener('change', renderLibrary)
$('lib-compact').addEventListener('change', renderLibrary)
$('lib-unread-only').addEventListener('change', renderLibrary)
$('lib-released-only').addEventListener('change', renderLibrary)
$('refresh').addEventListener('click', () => {
  if (state.scanning) window.kindle.scanStop()
  else window.kindle.sync()
})
$('login').addEventListener('click', () => window.kindle.openLogin())

restoreControls()
if (window.kindle.getVersion)
  window.kindle.getVersion().then((v) => { $('version').textContent = `v${v}` }).catch(() => {})
;(async () => {
  const data = await window.kindle.getBooks()
  if (data) {
    state.books = data.books || []
    state.syncedAt = data.syncedAt
    renderLibrary()
  }
  setStatus(fmtSynced())
})()
