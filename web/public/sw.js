// Cache for remote clients (registered only off loopback, see src/app/reload-prompt.tsx).
// The dev server sends hundreds of unbundled modules; each one answers from the cache at once and is checked
// against the server in the background. When a checked file changed, the pages are told so they can offer a reload.
const CACHE = 'ultimate-app-v1'
// Everything the page needs to boot. The API and event stream always go to the network. A module's `?t=` edit
// timestamp is part of its URL, so a cached `?t=` copy is always the version the page asked for.
const cacheable = (url) =>
  url.origin === location.origin &&
  !url.pathname.startsWith('/api/') &&
  (url.pathname === '/' ||
    /^\/(src|@fs|@id|@react-refresh|@vite|node_modules|icons|favicon|manifest)/.test(url.pathname))

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  ),
)

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || request.headers.has('range')) return
  // A hard reload asks for fresh files: it gets them, and they replace the cached ones.
  if (request.cache === 'reload' || request.cache === 'no-store') return
  const url = new URL(request.url)
  if (!cacheable(url)) return
  event.respondWith(request.mode === 'navigate' ? page(request) : answer(event, request))
})

/**
 * The page itself always comes from the network: it names the module versions to load. When it changed (an edit or
 * a server restart), the cached modules may no longer fit together, so they are dropped and the app loads fresh once.
 */
async function page(request) {
  told = false
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request, { cache: 'no-cache' })
    if (response.ok) {
      const cached = await cache.match(request)
      if (cached && version(cached) !== version(response)) await clear(cache)
      store(cache, request, response.clone())
    }
    return response
  } catch {
    // Offline: the last page loaded still starts the app from the cached modules.
    return (await cache.match(request)) ?? Response.error()
  }
}

const clear = async (cache) => Promise.all((await cache.keys()).map((key) => cache.delete(key)))
// A full or failing cache costs the next load's speed, never this one.
const store = (cache, request, response) => cache.put(request, response).catch(() => undefined)

async function answer(event, request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const refresh = fetch(request, { cache: 'no-cache' }).then(async (response) => {
    if (response.ok && cached) {
      const changed = version(cached) !== version(response)
      await store(cache, request, response.clone())
      if (changed) await tell()
    } else if (response.ok) event.waitUntil(store(cache, request, response.clone()))
    return response
  })
  if (!cached) return refresh
  // A failed check keeps the cached copy; the next load tries again.
  event.waitUntil(
    refresh.then(
      (response) => response.body?.cancel(),
      () => undefined,
    ),
  )
  return cached
}

const version = (response) => response.headers.get('etag') ?? response.headers.get('last-modified')

let told = false
async function tell() {
  if (told) return
  told = true
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Client.postMessage has no target origin.
  for (const client of await self.clients.matchAll()) client.postMessage({ type: 'stale' })
}
