// Dev-only: exercise lib/amazon.js parsers against live pages using the app session.
// Run: npx electron test-parse.js  (app must not be running)
const { app, session } = require('electron')
const path = require('path')
const { createAmazon } = require('./lib/amazon')

app.setPath('userData', path.join(app.getPath('appData'), 'kindle-shelf'))

app.whenReady().then(async () => {
  const amazon = createAmazon({
    getSession: () => session.fromPartition('persist:amazon'),
    saveRaw: (n, t) => require('fs').writeFileSync('/tmp/' + n, t),
  })
  try {
    const cards = await amazon.searchKindleStore('"Robert M. Kerns"', { maxPages: 1, tag: 'dbg' })
    console.log('SEARCH:', cards.length, 'cards')
    console.log(JSON.stringify(cards[0], null, 1))

    const meta = await amazon.fetchProductMeta('B0DF5WM6PC')
    console.log('META:', JSON.stringify({ ...meta, description: (meta.description || []).length + ' paras', reviews: (meta.reviews || []).length + ' reviews' }, null, 1))
    console.log('REVIEW SAMPLE:', JSON.stringify(meta.reviews?.[0] || null).slice(0, 300))

    const series = await amazon.fetchSeriesPage('B0DXQ862WJ')
    console.log('SERIES:', JSON.stringify({ ...series, volumes: undefined }, null, 1))
    console.log('VOLUMES:', JSON.stringify(series.volumes, null, 1).slice(0, 1500))
  } catch (e) {
    console.error('FAIL:', e)
    app.exit(1)
  }
  app.exit(0)
})
