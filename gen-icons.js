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
  console.log('icons written to renderer/icons/')
  app.exit(0)
})
