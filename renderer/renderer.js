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

// Toggle a manual read/unread override (also pushed to Amazon's own
// read-state record), then refresh whatever's on screen.
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
  if (state.view === 'series') renderSeries()
  else if (state.view === 'author') renderAuthor()
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

function bookRow(b, { showAuthors = true, extraBadges = [] } = {}) {
  const li = el('div', 'row')
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
  if (b.percentageRead > 0 && b.percentageRead < 100)
    li.append(badge('progress', `${b.percentageRead}% read`))
  for (const s of b.sources || []) li.append(badge(s))
  if (b.amazonRead) li.append(badge('progress', '✓ Finished'))
  if (b.read === false) li.append(badge('unread', 'Marked unread'))
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

// Compact row for an unread volume of a series (used in Library + Series tabs).
function volumeRow(v) {
  const row = el('div', 'row next-row')
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

function checkButton(g, rerender) {
  const btn = el('button', null, 'Check for new books')
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    btn.textContent = 'Checking…'
    btn.disabled = true
    await checkOne(g)
    rerender()
  })
  return btn
}

// ---------- tabs ----------

function showView(name) {
  state.view = name
  for (const t of document.querySelectorAll('nav .tab'))
    t.classList.toggle('active', t.dataset.view === name)
  $('view-library').classList.toggle('hidden', name !== 'library')
  $('view-author').classList.toggle('hidden', name !== 'author')
  $('view-series').classList.toggle('hidden', name !== 'series')
  if (name === 'series') loadSeriesView()
}

document.querySelectorAll('nav .tab').forEach((t) =>
  t.addEventListener('click', () => showView(t.dataset.view)))

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
  const grouped = $('group-series').checked
  for (const label of document.querySelectorAll('.needs-grouping')) {
    label.style.opacity = grouped ? 1 : 0.45
    label.querySelector('input').disabled = !grouped
  }
  const matches = libraryMatches()
  const q = $('search').value.trim()
  $('lib-summary').textContent = q
    ? `${matches.length} of ${state.books.length} books match “${q}”`
    : `${state.books.length} books`

  const wrap = $('lib-results')
  wrap.replaceChildren()
  if (grouped) renderLibraryGrouped(wrap, matches)
  else {
    for (const b of matches.slice(0, MAX_ROWS)) wrap.append(bookRow(b))
    if (matches.length > MAX_ROWS)
      wrap.append(el('div', 'summary', `…and ${matches.length - MAX_ROWS} more — narrow the search.`))
  }
}

function renderLibraryGrouped(wrap, matches) {
  const groups = state.seriesGroups
  if (!groups) {
    wrap.append(el('div', 'summary', 'Computing series…'))
    ensureSeriesGroups().then(renderLibrary)
    return
  }
  const unreadOnly = $('lib-unread-only').checked
  const releasedOnly = $('lib-released-only').checked
  const matchAsins = new Set(matches.map((b) => b.asin))
  const byAsin = new Map(state.books.map((b) => [b.asin, b]))
  const groupedAsins = new Set()
  for (const g of groups) for (const b of g.books) groupedAsins.add(b.asin)

  const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name))
  let shown = 0
  for (const g of sorted) {
    const members = g.books.map((b) => byAsin.get(b.asin)).filter(Boolean)
    if (!members.some((b) => matchAsins.has(b.asin))) continue

    const next = nextUnread(g.check, releasedOnly)
    if (unreadOnly) {
      if (g.check?.unresolved) continue
      if (g.check && (!next || !next.length)) continue
    }

    const sec = el('div', 'series-group')
    const head = el('h3')
    head.append(`${g.check?.name || g.name} · ${members.length} book${members.length > 1 ? 's' : ''}` +
      (g.check?.total ? ` of ${g.check.total}` : ''))
    if (!g.check) {
      head.append(' ')
      head.append(checkButton(g, renderLibrary))
    }
    sec.append(head)
    for (const b of members) sec.append(bookRow(b))
    if (next && next.length) {
      for (const v of next.slice(0, 4)) sec.append(volumeRow(v))
      if (next.length > 4) sec.append(el('div', 'summary', `…and ${next.length - 4} more unread`))
    } else if (g.check && !g.check.unresolved) {
      sec.append(el('div', 'summary caught-up', '✓ caught up'))
    }
    wrap.append(sec)
    shown++
  }

  if (!unreadOnly) {
    const solo = matches.filter((b) => !groupedAsins.has(b.asin))
    if (solo.length) {
      const sec = el('div', 'series-group')
      sec.append(el('h3', null, `No series detected · ${solo.length}`))
      for (const b of solo.slice(0, MAX_ROWS)) sec.append(bookRow(b))
      wrap.append(sec)
    }
  }
  if (!shown) wrap.append(el('div', 'summary', 'No series match the current filters.'))
}

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

// ---------- continue-series view ----------

async function loadSeriesView() {
  $('series-summary').textContent = 'Computing series…'
  await ensureSeriesGroups()
  renderSeries()
}

function renderSeries() {
  const releasedOnly = $('series-released-only').checked
  const continuableOnly = $('series-continuable-only').checked
  const groups = state.seriesGroups || []
  const wrap = $('series-results')
  wrap.replaceChildren()

  let shown = 0
  let checked = 0
  for (const g of groups) {
    if (g.check) checked++
    const next = nextUnread(g.check, releasedOnly)
    if (continuableOnly && g.check && !g.check.unresolved && (!next || !next.length)) continue
    if (continuableOnly && g.check?.unresolved) continue

    const sec = el('div', 'series-row')
    const head = el('div', 'series-head')
    const maxRead = Math.max(...g.books.map((b) => b.num ?? 0))
    head.append(el('span', 'title', g.check?.name || g.name))
    head.append(el('span', 'authors',
      `${g.books.length} read${maxRead ? ` · up to #${maxRead}` : ''}` +
      (g.check?.total ? ` · ${g.check.total} in series` : g.total ? ` · ${g.total} in series` : '')))

    const action = el('span', 'series-action')
    if (!g.check) {
      action.append(checkButton(g, renderSeries))
    } else if (g.check.unresolved) {
      action.append(el('span', 'summary', 'series page not found'))
    } else {
      const btn = el('button', null, '↻')
      btn.title = 'Re-check now'
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        btn.disabled = true
        await checkOne(g, { force: true })
        renderSeries()
      })
      action.append(btn)
    }
    head.append(action)
    sec.append(head)

    if (next && next.length) {
      for (const v of next.slice(0, 4)) sec.append(volumeRow(v))
      if (next.length > 4) sec.append(el('div', 'summary', `…and ${next.length - 4} more unread`))
    } else if (g.check && !g.check.unresolved) {
      sec.append(el('div', 'summary caught-up', '✓ caught up'))
    }
    wrap.append(sec)
    shown++
  }
  $('series-summary').textContent =
    `${groups.length} series · ${checked} checked · showing ${shown}` +
    (continuableOnly ? ' with unread books (or unchecked)' : '')
}

$('series-scan').addEventListener('click', async () => {
  if (state.scanning) {
    state.scanning = false
    $('series-scan').textContent = 'Scan unchecked series'
    return
  }
  state.scanning = true
  $('series-scan').textContent = 'Stop scan'
  const queue = (state.seriesGroups || []).filter((g) => !g.check)
  let done = 0
  for (const g of queue) {
    if (!state.scanning) break
    $('series-progress').textContent = `scanning ${g.name}… (${done}/${queue.length})`
    await checkOne(g)
    done++
    renderSeries()
  }
  state.scanning = false
  $('series-progress').textContent = `scan finished (${done} series)`
  $('series-scan').textContent = 'Scan unchecked series'
})

$('series-released-only').addEventListener('change', renderSeries)
$('series-continuable-only').addEventListener('change', renderSeries)

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
  if (e.key === 'Escape') $('details').classList.add('hidden')
})

// ---------- sync plumbing ----------

window.kindle.onSyncState((s) => {
  $('login-banner').classList.toggle('hidden', s.state !== 'needs-login')
  $('error-banner').classList.toggle('hidden', s.state !== 'error')
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
    setStatus(`${s.counts.owned} library + ${s.counts.ku} KU · ${fmtSynced()}`)
  }
})

$('search').addEventListener('input', renderLibrary)
$('group-series').addEventListener('change', renderLibrary)
$('lib-unread-only').addEventListener('change', renderLibrary)
$('lib-released-only').addEventListener('change', renderLibrary)
$('refresh').addEventListener('click', () => window.kindle.sync())
$('login').addEventListener('click', () => window.kindle.openLogin())

;(async () => {
  const data = await window.kindle.getBooks()
  if (data) {
    state.books = data.books || []
    state.syncedAt = data.syncedAt
    renderLibrary()
  }
  setStatus(fmtSynced())
})()
