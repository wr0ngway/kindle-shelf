// Dev-only: capture README screenshots from the running app's remote server.
// Run while the app is up: npx electron shots.js
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

app.setPath('userData', '/tmp/ks-shots')

const OUT = path.join(__dirname, 'docs', 'screenshots')
const settings = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), 'Library/Application Support/kindle-shelf/settings.json'), 'utf8'))
const BASE = `http://localhost:${settings.remote.port}`
const TOKEN = settings.remote.token

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shoot(win, name) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, name), img.toPNG())
  console.log('wrote', name)
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({ show: true, x: 40, y: 40, width: 1280, height: 860 })
  await win.loadURL(`${BASE}/?token=${TOKEN}`)
  await sleep(1500)
  // Suppress install banner, set the reading-queue view, reload so controls apply.
  await win.webContents.executeJavaScript(`
    localStorage.setItem('ks-install-dismissed', '1')
    localStorage.setItem('ctl:group-series', '1')
    localStorage.setItem('ctl:lib-sort', 'recent')
    localStorage.setItem('ctl:lib-released-only', '1')
    localStorage.setItem('ctl:lib-unread-only', '1')
    localStorage.setItem('ctl:lib-compact', '0')
    location.reload()
  `)
  await sleep(6000)
  await shoot(win, 'library-series.png')

  // Details drawer for a book with cached metadata.
  await win.webContents.executeJavaScript(`openDetails('B0DF5WM6PC')`)
  await sleep(2500)
  await shoot(win, 'details.png')
  await win.webContents.executeJavaScript(`document.getElementById('details').classList.add('hidden')`)

  // Author drill-down (may fetch live — give it time).
  await win.webContents.executeJavaScript(`openAuthorView('Robert M. Kerns')`)
  await sleep(20000)
  await shoot(win, 'author-view.png')
  win.close()

  // Phone-sized capture.
  const phone = new BrowserWindow({ show: true, x: 60, y: 60, width: 400, height: 850 })
  await phone.loadURL(`${BASE}/?token=${TOKEN}`)
  await sleep(1500)
  await phone.webContents.executeJavaScript(`
    localStorage.setItem('ks-install-dismissed', '1')
    localStorage.setItem('ctl:group-series', '1')
    localStorage.setItem('ctl:lib-sort', 'recent')
    localStorage.setItem('ctl:lib-compact', '1')
    localStorage.setItem('ctl:lib-unread-only', '1')
    location.reload()
  `)
  await sleep(6000)
  await shoot(phone, 'phone.png')

  app.exit(0)
})
