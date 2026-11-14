import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { Device } from '../shared/events.ts'

/** Who an access rule vouches a request came from: its login, and the client's address if the rule knows it. */
export type Identity = { login: string; address?: string }

export interface AccessRule {
  origin: string
  verify(request: {
    headers: IncomingHttpHeaders
  }): Identity | undefined | Promise<Identity | undefined>
}

export function createAccess(changed: () => void = () => {}) {
  const rules = new Set<AccessRule>()
  return {
    rules,
    origins: () => [...new Set([...rules].map((rule) => rule.origin))],
    allow(rule: AccessRule) {
      const url = new URL(rule.origin)
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== rule.origin)
        throw new Error('Access requires a full HTTP origin')
      rules.add(rule)
      changed()
      return () => {
        if (rules.delete(rule)) changed()
      }
    },
  }
}
export type Access = ReturnType<typeof createAccess>

/**
 * Whether a request may come in, and as whom: `{}` for a direct local client, else the identity of the access rule that
 * admitted it. Only that rule vouches for a login, so a request's own identity headers count only through it.
 */
export async function admit(
  request: Pick<IncomingMessage, 'headers' | 'method' | 'url'>,
  port: string,
  rules: Set<AccessRule>,
): Promise<Partial<Identity> | undefined> {
  const { host, origin } = request.headers
  if (
    !proxied(request.headers) &&
    loopbackAuthority(host, port) &&
    (!origin || loopbackOrigin(origin, port))
  )
    return {}
  const site = request.headers['sec-fetch-site']
  const navigation =
    (site === 'cross-site' || site === 'same-site') &&
    request.method === 'GET' &&
    (request.url === '/' || request.url?.startsWith('/?') === true) &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document' &&
    request.headers.upgrade === undefined
  // Root navigation relaxes only fetch metadata, not origin or identity verification.
  // Any site can now open the UI with any query, so query parameters must only select views, never act.
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !navigation)
    return undefined
  for (const rule of rules) {
    if (host !== new URL(rule.origin).host || (origin && origin !== rule.origin)) continue
    try {
      const identity = await rule.verify(request)
      if (identity?.login && rules.has(rule))
        return { login: identity.login, ...(identity.address && { address: identity.address }) }
    } catch {
      // A failed identity provider cannot admit a request.
    }
  }
  return undefined
}

/**
 * The short label of the browser behind a request, `phone safari` or `desktop chrome`, with the login and address
 * `admit` found for it. Nothing else of the request.
 */
export function deviceOf(headers: IncomingHttpHeaders, identity: Partial<Identity>): Device {
  const agent = headers['user-agent'] ?? ''
  const kind = /Mobi|iPhone|Android/.test(agent) ? 'phone' : 'desktop'
  const browser = /Edg\//.test(agent)
    ? 'edge'
    : /Firefox|FxiOS/.test(agent)
      ? 'firefox'
      : /Chrome|CriOS/.test(agent)
        ? 'chrome'
        : /Safari/.test(agent)
          ? 'safari'
          : 'other'
  return { device: `${kind} ${browser}`, ...identity }
}

export function proxied(headers: IncomingHttpHeaders) {
  return ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'].some(
    (key) => headers[key] !== undefined,
  )
}

export function loopbackAuthority(authority: string | undefined, port: string) {
  if (!authority) return false
  try {
    const url = new URL(`http://${authority}`)
    return (
      (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.hostname.endsWith('.localhost')) &&
      (url.port || '80') === port &&
      !url.username &&
      !url.password &&
      url.pathname === '/'
    )
  } catch {
    return false
  }
}
export function loopbackOrigin(origin: string, port: string) {
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && loopbackAuthority(url.host, port)
  } catch {
    return false
  }
}
