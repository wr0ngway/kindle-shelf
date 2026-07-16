// Thin wrapper around the tailscale CLI (if installed) for remote access:
// detect the tailnet address, and toggle `tailscale serve` so the app gets a
// stable, trusted-HTTPS tailnet URL (never exposed to the public internet).
const { execFile } = require('child_process')
const fs = require('fs')

const CLI_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
]

let cliPath
function cli() {
  if (cliPath !== undefined) return cliPath
  cliPath = CLI_CANDIDATES.find((p) => fs.existsSync(p)) || null
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

async function status() {
  if (!cli()) return { available: false }
  try {
    const s = JSON.parse(await run(['status', '--json']))
    if (!s.Self || s.BackendState !== 'Running') return { available: false, state: s.BackendState }
    return {
      available: true,
      dnsName: (s.Self.DNSName || '').replace(/\.$/, '') || null,
      ip: (s.Self.TailscaleIPs || []).find((ip) => ip.includes('.')) || null,
    }
  } catch {
    return { available: false }
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

module.exports = { status, serveActive, enableServe, disableServe }
