const $ = (id) => document.getElementById(id)
const MAX_ROWS = 1000
const BADGE_LABELS = { owned: 'Owned', 'ku-active': 'Kindle Unlimited', 'ku-returned': 'KU · returned' }

let books = []
let syncedAt = null

function setStatus(text) {
  $('status').textContent = text
}

function fmtSynced() {
  if (!syncedAt) return 'never synced'
  const mins = Math.round((Date.now() - new Date(syncedAt)) / 60000)
  return mins < 1 ? 'synced just now' : mins < 60 ? `synced ${mins}m ago` : `synced ${new Date(syncedAt).toLocaleString()}`
}

function render() {
  const q = $('search').value.trim().toLowerCase()
  const matches = !q
    ? books
    : books.filter(
        (b) =>
          b.authors.some((a) => a.toLowerCase().includes(q)) ||
          b.title.toLowerCase().includes(q)
      )

  $('summary').textContent = q
    ? `${matches.length} of ${books.length} books match “${$('search').value.trim()}”`
    : `${books.length} books`

  const list = $('results')
  list.replaceChildren()
  for (const b of matches.slice(0, MAX_ROWS)) {
    const li = document.createElement('li')
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = b.title
    const authors = document.createElement('span')
    authors.className = 'authors'
    authors.textContent = b.authors.join(', ')
    li.append(title, authors)
    for (const s of b.sources) {
      const badge = document.createElement('span')
      badge.className = `badge ${s}`
      badge.textContent = BADGE_LABELS[s] || s
      li.append(badge)
    }
    list.append(li)
  }
  if (matches.length > MAX_ROWS) {
    const li = document.createElement('li')
    li.textContent = `…and ${matches.length - MAX_ROWS} more — narrow the search.`
    list.append(li)
  }
}

function applyData(data) {
  if (!data) return
  books = data.books || []
  syncedAt = data.syncedAt
  render()
}

window.kindle.onSyncState((s) => {
  $('login-banner').classList.toggle('hidden', s.state !== 'needs-login')
  $('error-banner').classList.toggle('hidden', s.state !== 'error')
  if (s.state === 'syncing') setStatus(`Syncing — ${s.detail || ''}`)
  else if (s.state === 'needs-login') setStatus('Sign-in required')
  else if (s.state === 'error') {
    $('error-banner').textContent = `Sync failed: ${s.message}`
    setStatus(fmtSynced())
  } else if (s.state === 'done') {
    applyData(s)
    setStatus(`${s.counts.owned} library + ${s.counts.ku} KU · ${fmtSynced()}`)
  }
})

$('search').addEventListener('input', render)
$('refresh').addEventListener('click', () => window.kindle.sync())
$('login').addEventListener('click', () => window.kindle.openLogin())

;(async () => {
  applyData(await window.kindle.getBooks())
  setStatus(fmtSynced())
})()
