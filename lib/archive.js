// Archived-series registry: the pure data logic behind "hide a series I'm done
// with until I want it back". A record keeps BOTH identifiers because neither
// is durable alone — the grouping key comes from a series name that can change
// as metadata resolves (title guess -> real name), and the series ASIN isn't
// known until the series page has been scanned. Matching on asin OR key, and
// upgrading key-only records once an ASIN resolves, keeps an archive from
// silently vanishing. File IO lives in main.js; this module stays pure.
//
// Shape: { "<id>": { seriesAsin, key, name, archivedAt } }

const idFor = (ref) => (ref.seriesAsin ? `asin:${ref.seriesAsin}` : `key:${ref.key}`)

function sameSeries(a, b) {
  if (a.seriesAsin && b.seriesAsin && a.seriesAsin === b.seriesAsin) return true
  if (a.key && b.key && a.key === b.key) return true
  return false
}

// The archive record matching this group, or null.
function archivedRecord(map, group) {
  for (const r of Object.values(map || {})) if (sameSeries(r, group)) return r
  return null
}

function isArchived(map, group) {
  return Boolean(archivedRecord(map, group))
}

// Archive (or unarchive) a series, returning a new map. Any existing record for
// the same series is replaced, so re-archiving never duplicates.
function setArchived(map, ref, archived = true, now = new Date().toISOString()) {
  const next = { ...(map || {}) }
  for (const [id, r] of Object.entries(next)) if (sameSeries(r, ref)) delete next[id]
  if (archived && (ref.seriesAsin || ref.key)) {
    next[idFor(ref)] = {
      seriesAsin: ref.seriesAsin || null,
      key: ref.key || null,
      name: ref.name || null,
      archivedAt: now,
    }
  }
  return next
}

// Upgrade key-only records to carry an ASIN once a matching group resolves one.
// Returns { map, changed } so the caller only writes to disk when it matters.
function reconcileArchived(map, groups) {
  const next = { ...(map || {}) }
  let changed = false
  for (const [id, r] of Object.entries(next)) {
    if (r.seriesAsin) continue
    const g = (groups || []).find((x) => x.seriesAsin && sameSeries(r, x))
    if (!g) continue
    delete next[id]
    next[`asin:${g.seriesAsin}`] = { ...r, seriesAsin: g.seriesAsin }
    changed = true
  }
  return { map: next, changed }
}

module.exports = { setArchived, isArchived, archivedRecord, reconcileArchived }
