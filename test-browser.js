// Dev-only: simulate a phone browser hitting the remote server — a window
// with NO preload, so bridge.js must provide window.kindle over HTTP/SSE.
// Run while the app is serving: npx electron test-browser.js
const { app, BrowserWindow } = require('electron')

app.setPath('userData', '/tmp/ks-browser-test')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 900 })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL('http://localhost:8787/?token=testtok-e2e')
  await new Promise((r) => setTimeout(r, 4000))
  const probe = await win.webContents.executeJavaScript(`({
    hasKindle: !!window.kindle,
    status: document.getElementById('status')?.textContent,
    summary: document.getElementById('lib-summary')?.textContent,
    rows: document.querySelectorAll('#lib-results .row').length,
    remoteBtnHidden: document.getElementById('remote-btn')?.classList.contains('hidden'),
  })`)
  console.log(JSON.stringify(probe, null, 1))
  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'NO CONSOLE ERRORS')
  app.exit(errors.length ? 1 : 0)
})
