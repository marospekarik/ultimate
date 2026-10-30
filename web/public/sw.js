// Cache for remote clients (registered only off loopback, see src/app/reload-prompt.tsx).
// The dev server sends hundreds of unbundled modules; each one answers from the cache at once and is checked
// against the server in the background. When a checked file changed, the pages are told so they can offer a reload.
const CACHE = 'ultimate-app-v1'
// Everything the page needs to boot. The API, event stream and HMR updates (`?t=`) always go to the network.
const cacheable = (url) =>
  url.origin === location.origin &&
  !url.searchParams.has('t') &&
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
  const url = new URL(request.url)
  if (!cacheable(url)) return
  // A page load starts a new round: it may tell its page again.
  if (request.mode === 'navigate') told = false
  event.respondWith(answer(event, request))
})

async function answer(event, request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const refresh = fetch(request, { cache: 'no-cache' }).then(async (response) => {
    if (response.ok) {
      const changed = cached && version(cached) !== version(response)
      await cache.put(request, response.clone())
      if (changed) await tell()
    }
    return response
  })
  if (!cached) return refresh
  // A failed check keeps the cached copy; the next load tries again.
  event.waitUntil(refresh.catch(() => undefined))
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
