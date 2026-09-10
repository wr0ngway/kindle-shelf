// Browser bridge: when the UI is served over HTTP (phone/PWA) there is no
// Electron preload, so build window.kindle from fetch calls + server-sent
// events. In the Electron app window.kindle already exists and this is a no-op.
if (!window.kindle) {
  const listeners = { 'sync-state': [], 'scan-state': [] }
  let es = null

  function ensureEvents() {
    if (es) return
    es = new EventSource('/api/events')
    for (const ch of Object.keys(listeners)) {
      es.addEventListener(ch, (e) => {
        const data = JSON.parse(e.data)
        for (const cb of listeners[ch]) cb(data)
      })
    }
    es.onerror = () => {
      // Auto-reconnect is built into EventSource; nothing to do.
    }
  }

  async function call(path, opts) {
    const res = await fetch(path, opts)
    if (res.status === 401) {
      showUnauthorized()
      throw new Error('unauthorized')
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { msg = (await res.json()).error || msg } catch {}
      throw new Error(msg)
    }
    return res.json()
  }

  // Installed PWAs keep a separate cookie jar from the browser, so scanning
  // the QR in the browser never re-authorizes the PWA. Offer a token-input
  // form instead: the desktop panel shows the token, and pasting it here
  // re-sets the cookie in this device's own jar.
  function showUnauthorized() {
    const root = document.createElement('div')
    root.style.cssText = 'font-family:system-ui;padding:2rem;max-width:30rem'
    root.innerHTML =
      '<h2>Kindle Shelf</h2>' +
      '<p>This device is no longer authorized.</p>' +
      '<p>In the Kindle Shelf desktop app, open <b>Remote access</b> and copy the ' +
      '<b>Access token</b>. Paste it below to re-authorize this device.</p>'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Paste the access token'
    input.style.cssText = 'width:100%;padding:.5rem;margin:.5rem 0;box-sizing:border-box'
    const btn = document.createElement('button')
    btn.textContent = 'Authorize'
    btn.style.cssText = 'padding:.5rem 1rem'
    const status = document.createElement('p')
    btn.addEventListener('click', async () => {
      const token = input.value.trim()
      if (!token) return
      btn.disabled = true
      btn.textContent = 'Authorizing…'
      try {
        const r = await fetch('/api/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (r.ok) {
          status.textContent = '✓ Authorized — reloading…'
          setTimeout(() => location.reload(), 800)
        } else {
          status.textContent = 'Invalid token. Check the desktop app and try again.'
          btn.disabled = false
          btn.textContent = 'Authorize'
        }
      } catch {
        status.textContent = 'Could not reach the desktop app. Is it running?'
        btn.disabled = false
        btn.textContent = 'Authorize'
      }
    })
    root.append(input, btn, status)
    document.body.replaceChildren(root)
  }

  const post = (path, body) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

  window.kindle = {
    getBooks: () => call('/api/books'),
    getVersion: () => call('/api/version').then((r) => r.version),
    sync: () => post('/api/sync'),
    openLogin: () =>
      alert('Amazon sign-in only works in the Kindle Shelf desktop app. Sign in there, then Refresh here.'),
    openReader: (asin) => window.open(`https://read.amazon.com/?asin=${encodeURIComponent(asin)}`, '_blank'),
    openExternal: (url) => window.open(url, '_blank'),
    getDetails: (asin, opts) =>
      call(`/api/details?asin=${encodeURIComponent(asin)}${opts?.force ? '&force=1' : ''}`),
    seriesGroups: () => call('/api/series-groups'),
    seriesCheck: (key, opts) => post('/api/series-check', { key, force: Boolean(opts?.force) }),
    authorCatalog: (name, opts) => post('/api/author', { name, force: Boolean(opts?.force) }),
    setOverride: (asin, value) => post('/api/override', { asin, value }),
    scanStart: () => post('/api/scan-start'),
    scanStop: () => post('/api/scan-stop'),
    // Remote management is desktop-only; renderer hides the button when absent.
    onSyncState: (cb) => { listeners['sync-state'].push(cb); ensureEvents() },
    onScanState: (cb) => { listeners['scan-state'].push(cb); ensureEvents() },
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
    navigator.serviceWorker.register('/sw.js').catch(() => {})

  // ---- install-as-app promotion ----
  // Browsers never auto-install a PWA; best available UX is an in-page
  // button wired to Chrome's beforeinstallprompt, with instructions as
  // fallback (iOS has no install event at all).
  let installPrompt = null
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e
  })

  function showInstallBanner() {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone
    if (standalone || localStorage.getItem('ks-install-dismissed')) return

    const banner = document.createElement('div')
    banner.className = 'install-banner'
    const dismiss = () => {
      localStorage.setItem('ks-install-dismissed', '1')
      banner.remove()
    }

    if (installPrompt) {
      const btn = document.createElement('button')
      btn.className = 'primary'
      btn.textContent = '📲 Install Kindle Shelf'
      btn.addEventListener('click', async () => {
        installPrompt.prompt()
        const choice = await installPrompt.userChoice
        if (choice.outcome === 'accepted') banner.remove()
        installPrompt = null
      })
      banner.append(btn)
    } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      banner.append('Install as app: tap Share, then “Add to Home Screen”')
    } else {
      banner.append('Install as app: browser menu ⋮ → “Install app” / “Add to Home Screen”')
    }

    const x = document.createElement('button')
    x.className = 'install-dismiss'
    x.textContent = '✕'
    x.title = "Don't show again"
    x.addEventListener('click', dismiss)
    banner.append(x)
    document.body.append(banner)
    window.addEventListener('appinstalled', () => banner.remove())
  }

  // Give beforeinstallprompt a moment to fire before choosing which UI to show.
  window.addEventListener('load', () => setTimeout(showInstallBanner, 2500))
}
