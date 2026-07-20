// Amazon fetching + HTML parsing. Everything rides on the app's logged-in
// session partition; page fetches are throttled to stay polite.
const cheerio = require('cheerio')
const { net, BrowserWindow } = require('electron')

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December'
const DATE_RE = new RegExp(`(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}`)
const ASIN_RE = /(?:\/dp\/|\/gp\/product\/)(B0[A-Z0-9]{8})/

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const cleanAuthor = (a) => decodeEntities(a).replace(/:$/, '').trim()

function splitAuthors(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(cleanAuthor).filter(Boolean)
  if (typeof value === 'string') return value.split(/[;:]/).map(cleanAuthor).filter(Boolean)
  return []
}

// Best-effort series extraction from a title. Kindle titles in most genres
// encode the series; product-page metadata overrides this when cached.
function guessSeries(title) {
  const t = decodeEntities(title)
  const BOOK = '(?:Book|Volume|Vol\\.?)'
  let m = t.match(new RegExp(`\\(([^)]+?),?\\s+${BOOK}\\s+#?([\\d.]+)(?:\\s+of\\s+\\d+)?\\)`, 'i')) // (Series[,] Book/Volume 2)
  if (m) return mk(m[1], m[2])
  m = t.match(new RegExp(`\\(${BOOK}\\s+([\\d.]+)\\s+of\\s+(?:the\\s+)?([^)]+)\\)`, 'i')) // (Book 2 of Series)
  if (m) return mk(m[2], m[1])
  m = t.match(/\(([^)]+?)\s+#([\d.]+)\)/) // (Series #2)
  if (m) return mk(m[1], m[2])
  m = t.match(new RegExp(`^(.*?)[,:]?\\s+${BOOK}\\s+#?([\\d.]+)\\b`, 'i')) // Series[,:] Book/Volume 2 ...
  if (m && m[1]) return mk(m[1], m[2])
  m = t.match(/^([^:(]+?)\s+(\d+(?:\.\d+)?)\s*(?::|$)/) // Series 2: subtitle
  if (m) return mk(m[1], m[2])
  m = t.match(/\(([^)]+?)\s+(\d+(?:\.\d+)?)\)/) // (Series 2)
  if (m) return mk(m[1], m[2])
  return null

  function mk(name, num) {
    name = name.trim().replace(/[,:]$/, '')
    // Bare articles/generic words would group unrelated series together.
    if (!name || /^(the|a|an|book|volume|vol\.?|series)$/i.test(name)) return null
    return { name, num: parseFloat(num) }
  }
}

// Normalized grouping key: case/punctuation-insensitive, ignoring leading
// articles and generic trailing words ("X" ≡ "The X Series" ≡ "X Trilogy").
const seriesKey = (name) => {
  const k = name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+(series|trilogy|duology|saga)$/, '')
    .trim()
  return k || name.toLowerCase().trim()
}

function createAmazon({ getSession, partition = 'persist:amazon', saveRaw, log = () => {} }) {
  let chain = Promise.resolve()
  let lastAt = 0
  let pageWin = null

  function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = net.request({ url, method, session: getSession(), useSessionCookies: true })
      req.setHeader('User-Agent', USER_AGENT)
      for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
      req.on('response', (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }

  // HTML pages are fetched through a hidden browser window: a bare net.request
  // trips Amazon's bot verification, but a real renderer passes it (and runs
  // the interstitial's JS when one appears anyway).
  function ensurePageWin() {
    if (pageWin && !pageWin.isDestroyed()) return pageWin
    pageWin = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { partition, images: false, javascript: true },
    })
    return pageWin
  }

  function grabHtml(wc) {
    return wc.executeJavaScript('document.documentElement.outerHTML', true)
  }

  function loadStopped(wc, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('page load timed out'))
      }, timeoutMs)
      const onStop = () => { cleanup(); resolve() }
      const cleanup = () => {
        clearTimeout(timer)
        wc.removeListener('did-stop-loading', onStop)
      }
      wc.on('did-stop-loading', onStop)
    })
  }

  async function fetchHtmlPage(url) {
    const win = ensurePageWin()
    const wc = win.webContents
    const stopped = loadStopped(wc, 45000)
    wc.loadURL(url).catch(() => {}) // did-fail-load also fires did-stop-loading
    await stopped
    let html = await grabHtml(wc)
    // Bot-verification interstitial: it meta-refreshes itself after ~5s.
    for (let i = 0; i < 2 && /bm-verify/.test(html) && html.length < 20000; i++) {
      log('bot-verify interstitial, waiting for refresh…')
      await loadStopped(wc, 20000).catch(() => {})
      html = await grabHtml(wc)
    }
    const status = /Page Not Found|couldn't find that page/i.test(html.slice(0, 5000)) ? 404 : 200
    return { status, text: html }
  }

  // Throttled page fetch (~1/1.5s) so scans stay polite.
  function throttled(url) {
    const p = chain.catch(() => {}).then(async () => {
      const wait = Math.max(0, lastAt + 1500 - Date.now())
      if (wait) await new Promise((r) => setTimeout(r, wait))
      lastAt = Date.now()
      log(`fetch ${url.slice(0, 110)}`)
      return fetchHtmlPage(url)
    })
    chain = p
    return p
  }

  function parseSeriesLine(text) {
    const m = text.match(/Book\s+([\d.]+)\s+of\s+(\d+)\s*:?\s*(.*)/)
    if (!m) return null
    return { num: parseFloat(m[1]), total: parseInt(m[2], 10), name: m[3].trim() || null }
  }

  function parseSearchPage(html) {
    const $ = cheerio.load(html)
    const cards = []
    $('div[data-component-type="s-search-result"]').each((_, el) => {
      const $el = $(el)
      const asin = $el.attr('data-asin')
      if (!asin || !/^B0/.test(asin)) return
      if ($el.find('[data-component-type="sp-sponsored-result"]').length) return
      const title = $el.find('h2').first().text().trim()
      if (!title) return

      let series = null
      $el.find('a').each((_, a) => {
        const s = parseSeriesLine($(a).text().trim())
        if (s && s.name && !series) series = s
      })

      let authors = []
      $el.find('div.a-row').each((_, row) => {
        if (authors.length) return
        const t = $(row).text().replace(/\s+/g, ' ').trim()
        const m = t.match(/(?:^|\|)\s*by\s+([^|]+)/i)
        if (m)
          authors = m[1]
            .split(/,|\band\b/)
            .map((s) => s.trim())
            .filter((s) => s && s.length < 60 && !/Sold by/i.test(s))
      })

      const cardText = $el.text().replace(/\s+/g, ' ')
      const released = !/will be released|Pre-?order/i.test(cardText)
      const dateM = cardText.match(DATE_RE)
      const ratingM = cardText.match(/([\d.]+) out of 5 stars/)
      cards.push({
        asin,
        title,
        authors,
        series,
        cover: $el.find('img.s-image').attr('src') || null,
        released,
        releaseDate: dateM ? dateM[0] : null,
        rating: ratingM ? parseFloat(ratingM[1]) : null,
        kuAvailable: /Kindle Unlimited|Read for free/i.test(cardText),
      })
    })
    return cards
  }

  async function searchKindleStore(query, { maxPages = 3, tag } = {}) {
    const all = new Map()
    for (let page = 1; page <= maxPages; page++) {
      const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&i=digital-text&page=${page}`
      const res = await throttled(url)
      if (res.status !== 200) break
      if (tag) saveRaw(`search_${tag}_p${page}.html`, res.text)
      const cards = parseSearchPage(res.text)
      if (!cards.length) break
      for (const c of cards) if (!all.has(c.asin)) all.set(c.asin, c)
      if (cards.length < 12) break
    }
    return [...all.values()]
  }

  async function fetchProductMeta(asin) {
    const res = await throttled(`https://www.amazon.com/dp/${asin}`)
    if (res.status === 404) return { asin, missing: true }
    if (res.status !== 200) throw new Error(`product page ${asin}: HTTP ${res.status}`)
    const $ = cheerio.load(res.text)

    const seriesEl = $('#seriesBulletWidget_feature_div a').first()
    const series = parseSeriesLine(seriesEl.text().trim())
    const seriesAsinM = (seriesEl.attr('href') || '').match(ASIN_RE)

    const authors = []
    $('#bylineInfo .author a').each((_, a) => {
      const name = $(a).text().trim()
      if (name && !authors.includes(name) && !/^Visit|Follow/i.test(name)) authors.push(name)
    })

    const description = $('#bookDescription_feature_div .a-expander-content').length
      ? $('#bookDescription_feature_div .a-expander-content')
      : $('#bookDescription_feature_div')
    const descParas = []
    description.find('p, h3, li').each((_, p) => {
      const t = $(p).text().trim()
      if (t) descParas.push(t)
    })
    if (!descParas.length) {
      const t = description.text().trim()
      if (t) descParas.push(t)
    }

    const reviews = []
    $('[data-hook="review"]').slice(0, 5).each((_, r) => {
      const $r = $(r)
      const body =
        $r.find('[data-hook="reviewText"]').text().trim() ||
        $r.find('[data-hook="review-body"] .review-text-content').text().trim() ||
        $r.find('[data-hook="review-collapsed"]').text().trim() ||
        $r.find('[data-hook="review-body"]').text().trim()
      const starsM = ($r.find('[data-hook*="review-star"]').first().text() ||
        $r.find('.a-icon-alt').first().text()).match(/[\d.]+/)
      reviews.push({
        name: $r.find('.a-profile-name').first().text().trim(),
        stars: starsM ? starsM[0] : null,
        title: ($r.find('[data-hook="reviewTitle"]').text() ||
          $r.find('[data-hook="review-title"] span').last().text()).trim(),
        date: ($r.find('[data-hook="review-date"]').text().match(/on (.+)$/) || [null, null])[1],
        body: body
          .replace(/(Brief|Full) content visible, double tap to read (full|brief) content\./g, '')
          .replace(/\s*Read more\s*$/, '')
          .trim()
          .slice(0, 1500),
      })
    })

    const detailText = $('#detailBullets_feature_div').text().replace(/\s+/g, ' ')
    const pubM = detailText.match(new RegExp(`Publication date\\s*:?\\s*»?\\s*(${DATE_RE.source})`)) ||
                 detailText.match(DATE_RE)
    const bodyText = $('body').text()
    return {
      asin,
      title: $('#productTitle').text().trim() || null,
      authors,
      cover: $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src') || null,
      series: series ? { ...series, asin: seriesAsinM ? seriesAsinM[1] : null } : null,
      rating: (($('#acrPopover').attr('title') || '').match(/[\d.]+/) || [null])[0],
      reviewCount: ($('#acrCustomerReviewText').first().text().match(/[\d,]+/) || [null])[0],
      description: descParas,
      reviews,
      releaseDate: pubM ? (pubM[1] || pubM[0]) : null,
      released: !/will be released|Pre-?order now/i.test(bodyText.slice(0, 100000)),
      kuAvailable: /Read for free|Kindle Unlimited/i.test(bodyText.slice(0, 100000)),
    }
  }

  async function fetchSeriesPage(seriesAsin) {
    const res = await throttled(`https://www.amazon.com/dp/${seriesAsin}`)
    if (res.status !== 200) throw new Error(`series page ${seriesAsin}: HTTP ${res.status}`)
    saveRaw(`series_${seriesAsin}.html`, res.text)
    const $ = cheerio.load(res.text)
    const name =
      $('#collection-title').text().trim() ||
      $('#productTitle').text().trim().replace(/\s*\(\d+ book series\)\s*/i, '') ||
      $('title').text().replace(/\s*\(\d+ book series\).*$/i, '').trim() ||
      null
    const totalM = $('body').text().match(/\((\d+) book series\)/i)

    const volumes = []
    $('[id^="series-childAsin-item"]').each((i, el) => {
      const $el = $(el)
      const titleEl = $el.find('[id^="itemBookTitle"]').first()
      const title = titleEl.text().trim()
      if (!title) return
      const href = titleEl.attr('href') || $el.find('a[href*="/dp/"]').attr('href') || ''
      const asinM = href.match(ASIN_RE)
      const text = $el.text().replace(/\s+/g, ' ')
      const posM = text.match(/^\s*(\d+)\b/)
      const dateM = text.match(DATE_RE)
      volumes.push({
        asin: asinM ? asinM[1] : null,
        title,
        position: posM ? parseInt(posM[1], 10) : i + 1,
        purchased: /Purchased|You purchased/i.test(text),
        released: !/will be released|Pre-?order/i.test(text),
        releaseDate: dateM ? dateM[0] : null,
        kuAvailable: /Kindle Unlimited|Read for free/i.test(text),
        cover: $el.find('img').attr('src') || null,
      })
    })
    return {
      asin: seriesAsin,
      name,
      total: totalM ? parseInt(totalM[1], 10) : volumes.length,
      volumes,
      truncated: totalM ? volumes.length < parseInt(totalM[1], 10) : false,
    }
  }

  return { rawRequest, throttled, searchKindleStore, fetchProductMeta, fetchSeriesPage }
}

module.exports = { createAmazon, decodeEntities, cleanAuthor, splitAuthors, guessSeries, seriesKey, USER_AGENT }
