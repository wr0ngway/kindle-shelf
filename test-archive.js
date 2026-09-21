// Pure-logic tests for lib/archive.js. Run with plain node:
//   node test-archive.js
const assert = require('assert')
const {
  setArchived,
  isArchived,
  archivedRecord,
  reconcileArchived,
} = require('./lib/archive')

const NOW = '2026-01-01T00:00:00.000Z'
let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (e) {
    console.error(`FAIL - ${name}`)
    console.error(e)
    process.exitCode = 1
  }
}

const group = (over = {}) => ({ key: 'the-expanse', seriesAsin: null, name: 'The Expanse', ...over })

test('archiving stores a record keyed by series asin', () => {
  const map = setArchived({}, group({ seriesAsin: 'B08X' }), true, NOW)
  assert.strictEqual(isArchived(map, group({ seriesAsin: 'B08X' })), true)
  const rec = archivedRecord(map, group({ seriesAsin: 'B08X' }))
  assert.strictEqual(rec.seriesAsin, 'B08X')
  assert.strictEqual(rec.key, 'the-expanse')
  assert.strictEqual(rec.archivedAt, NOW)
})

test('unarchiving removes the record', () => {
  let map = setArchived({}, group({ seriesAsin: 'B08X' }), true, NOW)
  map = setArchived(map, group({ seriesAsin: 'B08X' }), false, NOW)
  assert.strictEqual(isArchived(map, group({ seriesAsin: 'B08X' })), false)
})

test('re-archiving does not duplicate the record', () => {
  let map = setArchived({}, group({ seriesAsin: 'B08X' }), true, NOW)
  map = setArchived(map, group({ seriesAsin: 'B08X', name: 'The Expanse Series' }), true, NOW)
  assert.strictEqual(Object.keys(map).length, 1)
})

test('a key-only archive still matches once asin resolves', () => {
  const map = setArchived({}, group(), true, NOW)
  assert.strictEqual(isArchived(map, group({ seriesAsin: 'B08X' })), true)
})

test('name drift does not orphan an archive that has a series asin', () => {
  const map = setArchived({}, group({ seriesAsin: 'B08X' }), true, NOW)
  // Series name was corrected; key changed, asin is the durable link.
  assert.strictEqual(isArchived(map, group({ key: 'expanse', seriesAsin: 'B08X' })), true)
})

test('unarchiving only removes the matching series', () => {
  let map = setArchived({}, group({ seriesAsin: 'B08X' }), true, NOW)
  map = setArchived(map, group({ key: 'dune', seriesAsin: 'B09Y', name: 'Dune' }), true, NOW)
  map = setArchived(map, group({ seriesAsin: 'B08X' }), false, NOW)
  assert.strictEqual(isArchived(map, group({ seriesAsin: 'B08X' })), false)
  assert.strictEqual(isArchived(map, group({ key: 'dune', seriesAsin: 'B09Y' })), true)
})

test('unrelated series are not archived', () => {
  const map = setArchived({}, group({ seriesAsin: 'B08X' }), true, NOW)
  assert.strictEqual(isArchived(map, group({ key: 'dune', seriesAsin: 'B09Y' })), false)
})

test('reconcile upgrades a key-only record to carry the resolved asin', () => {
  const map = setArchived({}, group(), true, NOW)
  const { map: next, changed } = reconcileArchived(map, [group({ seriesAsin: 'B08X' })])
  assert.strictEqual(changed, true)
  const rec = archivedRecord(next, group({ seriesAsin: 'B08X' }))
  assert.strictEqual(rec.seriesAsin, 'B08X')
  assert.strictEqual(Object.keys(next).length, 1)
})

test('reconcile leaves already-complete records untouched', () => {
  const map = setArchived({}, group({ seriesAsin: 'B08X' }), true, NOW)
  const { map: next, changed } = reconcileArchived(map, [group({ seriesAsin: 'B08X' })])
  assert.strictEqual(changed, false)
  assert.deepStrictEqual(next, map)
})

console.log(`\n${passed} passed`)
