// Dev-only endpoint probe: reuses the app's Amazon session to test candidate
// endpoints. Run: npx electron probe.js (app must not be running)
const { app, session } = require('electron')
const path = require('path')
const fs = require('fs')
const { createAmazon } = require('./lib/amazon')

app.setPath('userData', path.join(app.getPath('appData'), 'kindle-shelf'))
const OUT = path.join(__dirname, 'probe-out')

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const amazon = createAmazon({
    getSession: () => session.fromPartition('persist:amazon'),
    saveRaw: () => {},
    log: console.log,
  })
  const res = await amazon.throttled(
    'https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc')
  fs.writeFileSync(path.join(OUT, 'mycd_console.html'), res.text)
  console.log('mycd_console.html', res.status, res.text.length, 'bytes')

  // Pull the JS bundles the console loads — endpoint names live in them.
  const scripts = [...res.text.matchAll(/src="(https:\/\/[^"]+\.js[^"]*)"/g)].map((m) => m[1])
  console.log('scripts found:', scripts.length)
  let i = 0
  for (const src of scripts) {
    if (!/mycd|digital|console|content/i.test(src)) continue
    const r = await amazon.rawRequest(src)
    fs.writeFileSync(path.join(OUT, `bundle_${i++}.js`), r.text)
    console.log('bundle', src.slice(0, 120), r.text.length)
  }
  app.exit(0)
})
