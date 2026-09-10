// Thin wrapper around the tailscale CLI for remote access: detect install/
// login state (to drive the setup stepper), read the tailnet address, and
// toggle `tailscale serve` so the app gets a stable, trusted-HTTPS tailnet
// URL (never exposed to the public internet).
const { execFile } = require('child_process')
const fs = require('fs')

const CLI_CANDIDATES = {
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ],
  win32: [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  ],
  linux: ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'],
}

const DOWNLOAD_URLS = {
  darwin: 'https://tailscale.com/download/mac',
  win32: 'https://tailscale.com/download/windows',
  linux: 'https://tailscale.com/download/linux',
}

const PHONE_STORE_URLS = {
  android: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
  ios: 'https://apps.apple.com/app/tailscale/id1470499037',
}

let cliPath = null
function cli() {
  // Cache only a found path — the user may install Tailscale while the app
  // is running (the setup stepper counts on re-detection).
  if (!cliPath) cliPath = (CLI_CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p)) || null
  return cliPath
}

function run(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const bin = cli()
    if (!bin) return reject(new Error('tailscale CLI not found'))
    // The Tailscale CLI on macOS only connects to the already-running GUI
    // app when it thinks it's in a terminal session; otherwise it tries to
    // launch a new GUI and fails with "The Tailscale GUI failed to start".
    // The packaged app spawns the CLI with a minimal env, so set the vars
    // the CLI keys off explicitly.
    const env = {
      ...process.env,
      TERM_PROGRAM: process.env.TERM_PROGRAM || 'Apple_Terminal',
      TERM: process.env.TERM || 'xterm-256color',
    }
    execFile(bin, args, { timeout, env }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr?.trim() || err.message)
        e.stdout = stdout || '' // partial output survives a timeout kill
        reject(e)
      } else resolve(stdout)
    })
  })
}

// state: 'not-installed' | 'needs-login' | 'stopped' | 'starting' | 'running' | 'error'
async function status() {
  if (!cli()) return { installed: false, state: 'not-installed' }
  // The CLI can fail transiently (daemon hiccup, brief timeout, first-run
  // warm-up). Retry a few times before giving up, so a one-off failure
  // doesn't leave the remote panel stuck on the setup stepper.
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const s = JSON.parse(await run(['status', '--json']))
      const backend = s.BackendState || ''
      if (backend === 'Running' && s.Self) {
        return {
          installed: true,
          state: 'running',
          dnsName: (s.Self.DNSName || '').replace(/\.$/, '') || null,
          ip: (s.Self.TailscaleIPs || []).find((ip) => ip.includes('.')) || null,
        }
      }
      const state = { NeedsLogin: 'needs-login', Stopped: 'stopped', Starting: 'starting' }[backend] || 'stopped'
      return { installed: true, state }
    } catch (e) {
      lastErr = e
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500))
    }
  }
  // Surface the underlying failure so the remote panel can show why
  // detection failed (CLI missing, exec error, JSON parse, etc.).
  return { installed: true, state: 'error', detail: String(lastErr?.message || lastErr) }
}

async function serveActive(port) {
  try {
    const out = await run(['serve', 'status'])
    return out.includes(`:${port}`)
  } catch {
    return false
  }
}

// `serve` can require a one-time tailnet approval: the CLI prints an enable
// URL and blocks until it's visited. Detect that and surface the URL.
async function enableServe(port) {
  try {
    return await run(['serve', '--bg', String(port)], 20000)
  } catch (e) {
    const m = `${e.stdout || ''}\n${e.message}`.match(/To enable, visit:\s*(https:\/\/\S+)/)
    if (m) {
      const err = new Error('Serve needs a one-time approval for your tailnet')
      err.enableUrl = m[1]
      throw err
    }
    throw e
  }
}
const disableServe = () => run(['serve', 'reset'])
const downloadUrl = () => DOWNLOAD_URLS[process.platform] || 'https://tailscale.com/download'

module.exports = { status, serveActive, enableServe, disableServe, downloadUrl, PHONE_STORE_URLS }
