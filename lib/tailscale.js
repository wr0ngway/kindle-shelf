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

let cliPath
function cli() {
  if (cliPath !== undefined) return cliPath
  cliPath = (CLI_CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p)) || null
  return cliPath
}

function run(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const bin = cli()
    if (!bin) return reject(new Error('tailscale CLI not found'))
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
  })
}

// state: 'not-installed' | 'needs-login' | 'stopped' | 'starting' | 'running' | 'error'
async function status() {
  if (!cli()) return { installed: false, state: 'not-installed' }
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
  } catch {
    return { installed: true, state: 'error' }
  }
}

async function serveActive(port) {
  try {
    const out = await run(['serve', 'status'])
    return out.includes(`:${port}`)
  } catch {
    return false
  }
}

const enableServe = (port) => run(['serve', '--bg', String(port)])
const disableServe = () => run(['serve', 'reset'])
const downloadUrl = () => DOWNLOAD_URLS[process.platform] || 'https://tailscale.com/download'

module.exports = { status, serveActive, enableServe, disableServe, downloadUrl, PHONE_STORE_URLS }
