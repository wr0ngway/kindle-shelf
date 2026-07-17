// Dev-only: render all app icons from one books-on-a-shelf design.
// Run: npx electron gen-icons.js
// Outputs:
//   build/icon.png          1024px, macOS-style margin + rounded rect (electron-builder
//                           converts to .icns/.ico for mac/win/linux)
//   renderer/icons/icon-512.png, icon-192.png   full-bleed PWA icons
//   renderer/icons/trayTemplate.png (+@2x)      black+alpha menu-bar silhouette
const { app, BrowserWindow, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

// Draw routine shared by every variant. Books-on-a-shelf on a 100-unit box.
const DRAW = `
function drawArt(g, S, opts) {
  const u = S / 100
  if (opts.bg) {
    const m = opts.margin * u
    const r = opts.radius * u
    const grad = g.createLinearGradient(m, m, S - m, S - m)
    grad.addColorStop(0, '#b45309')
    grad.addColorStop(1, '#f59e0b')
    g.fillStyle = grad
    g.beginPath()
    g.roundRect(m, m, S - 2 * m, S - 2 * m, r)
    g.fill()
  }
  // Content box for the books (relative to the 100-unit grid)
  const pad = (opts.margin + opts.inset) * u
  const w = S - 2 * pad
  const x = (f) => pad + f * w
  const y = (f) => pad + f * w
  g.fillStyle = opts.ink
  const bw = 0.17 * w // book spine width
  const shelfY = 0.86
  // three spines of differing heights, resting on the shelf
  g.beginPath(); g.roundRect(x(0.08), y(0.22), bw, y(shelfY) - y(0.22), 2 * u); g.fill()
  g.beginPath(); g.roundRect(x(0.32), y(0.06), bw, y(shelfY) - y(0.06), 2 * u); g.fill()
  g.beginPath(); g.roundRect(x(0.56), y(0.28), bw, y(shelfY) - y(0.28), 2 * u); g.fill()
  // leaning book
  g.save()
  g.translate(x(0.78), y(shelfY))
  g.rotate(-0.22)
  g.beginPath(); g.roundRect(0, -(y(shelfY) - y(0.30)), bw, y(shelfY) - y(0.30), 2 * u); g.fill()
  g.restore()
  // shelf
  g.beginPath(); g.roundRect(x(0), y(shelfY), w, 0.055 * w, 1.5 * u); g.fill()
}
`

async function render(win, size, opts) {
  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    ${DRAW}
    const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size}
    drawArt(c.getContext('2d'), ${size}, ${JSON.stringify(opts)})
    return c.toDataURL('image/png')
  })()`)
  return nativeImage.createFromDataURL(dataUrl)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 })
  await win.loadURL('data:text/html,<body></body>')

  const iconsDir = path.join(__dirname, 'renderer', 'icons')
  const buildDir = path.join(__dirname, 'build')
  fs.mkdirSync(iconsDir, { recursive: true })
  fs.mkdirSync(buildDir, { recursive: true })

  // App icon: macOS-style transparent margin, rounded square, cream books.
  const appIcon = await render(win, 1024, { bg: true, margin: 8.5, radius: 18.5, inset: 14, ink: '#fffbeb' })
  fs.writeFileSync(path.join(buildDir, 'icon.png'), appIcon.toPNG())

  // PWA icons: full-bleed (maskable-friendly), same art.
  const pwa = await render(win, 512, { bg: true, margin: 0, radius: 0, inset: 18, ink: '#fffbeb' })
  fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), pwa.toPNG())
  fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), pwa.resize({ width: 192 }).toPNG())

  // Menu-bar template: same silhouette, pure black + alpha, no background.
  const tray = await render(win, 32, { bg: false, margin: 0, radius: 0, inset: 2, ink: '#000000' })
  fs.writeFileSync(path.join(iconsDir, 'trayTemplate@2x.png'), tray.toPNG())
  fs.writeFileSync(path.join(iconsDir, 'trayTemplate.png'), tray.resize({ width: 16, height: 16 }).toPNG())

  console.log('icons written: build/icon.png, renderer/icons/{icon-512,icon-192,trayTemplate,trayTemplate@2x}.png')
  app.exit(0)
})
