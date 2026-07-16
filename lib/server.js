// Remote-access HTTP server: serves the same renderer UI to browsers (phone
// PWA) and exposes the app's API over HTTP + server-sent events. Gated by a
// persistent token: first visit arrives as /?token=… (from the QR code),
// which is exchanged for a long-lived HttpOnly cookie.
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

// Fetched before auth can complete (PWA plumbing) — no data in them.
const PUBLIC_PATHS = new Set(['/manifest.json', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png'])

function tokenEqual(a, b) {
  if (!a || !b) return false
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function createRemoteServer({ port, staticDir, getToken, api, log = () => {} }) {
  staticDir = path.resolve(staticDir)
  const clients = new Set()

  function authed(req) {
    const cookies = Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map((c) => c.trim().split('=').map(decodeURIComponent))
        .filter((p) => p[0]))
    return tokenEqual(cookies.ks_token, getToken())
  }

  function serveStatic(p, res) {
    const file = path.resolve(path.join(staticDir, p))
    if (!file.startsWith(staticDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404)
      return res.end('not found')
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const p = url.pathname

      const qToken = url.searchParams.get('token')
      if (qToken) {
        if (!tokenEqual(qToken, getToken())) {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          return res.end('Invalid token')
        }
        res.writeHead(302, {
          'Set-Cookie': `ks_token=${encodeURIComponent(getToken())}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
          Location: p,
        })
        return res.end()
      }

      if (PUBLIC_PATHS.has(p)) return serveStatic(p, res)

      if (!authed(req)) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(
          '<!doctype html><meta name="viewport" content="width=device-width">' +
          '<body style="font-family:system-ui;padding:2rem;max-width:30rem">' +
          '<h2>Kindle Shelf</h2><p>Not authorized on this device.</p>' +
          '<p>Open <b>Remote access</b> in the Kindle Shelf desktop app and scan the QR code again.</p>')
      }

      if (p === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }

      if (p.startsWith('/api/')) {
        const handler = api[`${req.method} ${p}`]
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          return res.end('{"error":"unknown endpoint"}')
        }
        let body = null
        if (req.method === 'POST') {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const text = Buffer.concat(chunks).toString()
          body = text ? JSON.parse(text) : {}
        }
        const result = await handler({ query: url.searchParams, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(result ?? null))
      }

      return serveStatic(p === '/' ? '/index.html' : p, res)
    } catch (e) {
      log(`error: ${String(e.message || e)}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e.message || e) }))
    }
  })

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': hb\n\n')
  }, 30000)

  function broadcast(channel, payload) {
    const msg = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const c of clients) c.write(msg)
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '0.0.0.0', () => {
      log(`listening on :${port}`)
      resolve({
        broadcast,
        close: () => {
          clearInterval(heartbeat)
          for (const c of clients) c.end()
          server.close()
        },
      })
    })
  })
}

module.exports = { createRemoteServer }
