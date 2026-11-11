// Cold and warm page load as a phone sees it: node phone-load.ts <url> [--runs 3]
// Fresh Chromium context, phone viewport, "Fast 4G" throttling over CDP. Prints one JSON line per load and medians.
import { chromium, type CDPSession, type Page } from 'playwright-core'
import { browserBinary } from '../../../extensions/browser/server.ts'

const url = process.argv[2]
if (!url) throw new Error('usage: phone-load.ts <url> [--runs N]')
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]

async function load(page: Page, cdp: CDPSession, reload: boolean) {
  const reqs = new Map<string, any>()
  cdp.on('Network.requestWillBeSent', (e: any) => reqs.set(e.requestId, { url: e.request.url }))
  cdp.on('Network.responseReceived', (e: any) => {
    const r = reqs.get(e.requestId)
    if (r)
      Object.assign(r, {
        status: e.response.status,
        fromCache: e.response.fromDiskCache || e.response.fromPrefetchCache,
      })
  })
  cdp.on('Network.loadingFinished', (e: any) => {
    const r = reqs.get(e.requestId)
    if (r) r.wire = e.encodedDataLength
  })
  cdp.on('Network.dataReceived', (e: any) => {
    const r = reqs.get(e.requestId)
    if (r) r.decoded = (r.decoded ?? 0) + e.dataLength
  })
  const t0 = Date.now()
  await (reload ? page.reload({ waitUntil: 'commit' }) : page.goto(url, { waitUntil: 'commit' }))
  // "Usable": the composer is on screen. Adjust the selector if the composer changes.
  await page.locator('textarea, [contenteditable="true"]').first().waitFor({ timeout: 60000 })
  const usableMs = Date.now() - t0
  await page.waitForLoadState('networkidle', { timeout: 60000 })
  const fcp = await page.evaluate(
    () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
  )
  const all = [...reqs.values()]
  return {
    requests: all.length,
    wireMB: +(all.reduce((s, r) => s + (r.wire ?? 0), 0) / 1e6).toFixed(2),
    decodedMB: +(all.reduce((s, r) => s + (r.decoded ?? 0), 0) / 1e6).toFixed(2),
    fcpMs: fcp && Math.round(fcp),
    usableMs,
    s200: all.filter((r) => r.status === 200 && !r.fromCache && r.wire > 0).length,
    s304: all.filter((r) => r.status === 304).length,
    cache: all.filter((r) => r.fromCache || (r.status === 200 && !r.wire)).length,
  }
}

const browser = await chromium.launch({ executablePath: await browserBinary() })
const cold: any[] = []
const warm: any[] = []
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
  })
  cold.push(await load(page, cdp, false))
  warm.push(await load(page, cdp, true))
  console.log(JSON.stringify({ run: i, cold: cold[i], warm: warm[i] }))
  await ctx.close()
}
await browser.close()
for (const [name, rows] of [
  ['cold', cold],
  ['warm', warm],
] as const)
  console.log(
    name,
    'median',
    JSON.stringify(
      Object.fromEntries(Object.keys(rows[0]).map((k) => [k, median(rows.map((r) => r[k] ?? 0))])),
    ),
  )
