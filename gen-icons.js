// Dev-only: render the PWA/app icons with Electron. Run: npx electron gen-icons.js
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 512, height: 512, frame: false })
  const html = `<body style="margin:0">
    <div style="width:512px;height:512px;display:flex;align-items:center;justify-content:center;
                background:linear-gradient(135deg,#92400e,#f59e0b);border-radius:0">
      <div style="font-size:300px;line-height:1">📚</div>
    </div></body>`
  await win.loadURL('data:text/html,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 800))
  const img = await win.webContents.capturePage()
  const dir = path.join(__dirname, 'renderer', 'icons')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'icon-512.png'), img.resize({ width: 512 }).toPNG())
  fs.writeFileSync(path.join(dir, 'icon-192.png'), img.resize({ width: 192 }).toPNG())

  // macOS menu-bar template icon: pure black + alpha (books on a shelf),
  // drawn on canvas so transparency survives.
  const { nativeImage } = require('electron')
  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32
    const g = c.getContext('2d'); g.fillStyle = '#000'
    g.fillRect(3, 8, 6, 19)   // book 1
    g.fillRect(11, 4, 6, 23)  // book 2 (taller)
    g.fillRect(19, 10, 6, 17) // book 3, slightly tilted look via offset
    g.fillRect(2, 28, 28, 2)  // shelf
    return c.toDataURL('image/png')
  })()`)
  const trayImg = nativeImage.createFromDataURL(dataUrl)
  fs.writeFileSync(path.join(dir, 'trayTemplate@2x.png'), trayImg.toPNG())
  fs.writeFileSync(path.join(dir, 'trayTemplate.png'), trayImg.resize({ width: 16, height: 16 }).toPNG())
  console.log('icons written to renderer/icons/')
  app.exit(0)
})
