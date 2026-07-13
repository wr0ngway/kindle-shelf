// Dev-only endpoint probe: reuses the app's Amazon session to test candidate
// endpoints for series/catalog metadata. Run: npx electron probe.js
const { app, session, net } = require('electron')
const path = require('path')
const fs = require('fs')

app.setPath('userData', path.join(app.getPath('appData'), 'kindle-shelf'))
const OUT = path.join(__dirname, 'probe-out')
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

function request(ses, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, session: ses, useSessionCookies: true })
    req.setHeader('User-Agent', UA)
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const ses = session.fromPartition('persist:amazon')
  const probes = [
    ['series_page.html', 'https://www.amazon.com/dp/B0DXQ862WJ'],
  ]
  for (const [name, url] of probes) {
    try {
      const res = await request(ses, url)
      fs.writeFileSync(path.join(OUT, name), res.text)
      console.log(name, res.status, `${res.text.length} bytes`)
    } catch (e) {
      console.log(name, 'ERROR', String(e))
    }
  }
  app.exit(0)
})
