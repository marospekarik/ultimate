import { RotateCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/

/**
 * Remote clients (the phone over the tailnet) run behind a service worker that answers the app's files from its cache
 * and checks them in the background. When a file changed, the cached app is out of date until the next load: offer it.
 * On loopback there is no worker, so hot reload stays as it is.
 */
export function ReloadPrompt() {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    if (!('serviceWorker' in navigator) || loopback.test(location.hostname)) return undefined
    // oxlint-disable-next-line typescript/no-floating-promises -- an unregistrable worker only costs the cache.
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
    const listen = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'stale') setStale(true)
    }
    navigator.serviceWorker.addEventListener('message', listen)
    return () => navigator.serviceWorker.removeEventListener('message', listen)
  }, [])
  if (!stale) return null
  return (
    <div
      className="fixed top-12 left-1/2 z-40 flex w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-border/80 bg-popover px-3 py-2 font-mono text-[11.5px] shadow-lg"
      role="status"
    >
      <span className="text-foreground/90">A newer version is ready.</span>
      <Button onClick={() => location.reload()} size="xs" variant="outline">
        <RotateCwIcon />
        Reload
      </Button>
    </div>
  )
}
