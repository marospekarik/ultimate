import { createPublicKey, verify } from 'node:crypto'
import { defineExtension } from '@earendil-works/pi-durable'
import { readJson } from '../../lib/json-file.ts'
import { userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

export const reloadOnSettings = true

export interface CfAccessSettings {
  /** The Zero Trust team name: `<team>.cloudflareaccess.com`. */
  team: string
  /** The Access application's AUD tag. */
  aud: string
  /** The public origin Cloudflare serves, such as `https://ultimate.example.com`. */
  origin: string
  /** Email addresses admitted, compared case-insensitively. */
  allow: string[]
}
type Jwk = { kid?: string; kty?: string; n?: string; e?: string }

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/**
 * The email of a valid Cloudflare Access token, else undefined: RS256 signature by one of `keys`, issuer, audience
 * and expiry as configured, and an email on the allowlist. The header is never trusted for the algorithm.
 */
export function verifyToken(
  token: string,
  keys: Jwk[],
  { team, aud, allow }: Pick<CfAccessSettings, 'team' | 'aud' | 'allow'>,
  now = Date.now() / 1000,
) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const header = decode(parts[0])
  const jwk = keys.find((key) => key.kid === header.kid)
  if (header.alg !== 'RS256' || !jwk) return undefined
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
  const signature = Buffer.from(parts[2], 'base64url')
  if (!verify('RSA-SHA256', signed, createPublicKey({ key: jwk, format: 'jwk' }), signature))
    return undefined
  const claims = decode(parts[1])
  const audiences = [claims.aud].flat()
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
  if (
    claims.iss !== `https://${team}.cloudflareaccess.com` ||
    !audiences.includes(aud) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    !allow.some((entry) => entry.toLowerCase() === email)
  )
    return undefined
  return email
}

export default function cfAccess(host: ExtensionHost) {
  let remove: (() => void) | undefined
  let keys: Jwk[] = []
  let fetchedAt = 0
  async function refresh(team: string) {
    // At most one fetch a minute, so a stream of unknown key ids cannot turn this into a request flood.
    if (Date.now() - fetchedAt < 60_000) return
    fetchedAt = Date.now()
    const response = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`)
    if (!response.ok) throw new Error(`Access certs: ${response.status}`)
    keys = ((await response.json()) as { keys: Jwk[] }).keys
  }
  host.onOpen(async () => {
    const settings = await readJson<{ cfAccess?: CfAccessSettings }>(
      userSettingsPath(host.userHome),
      {},
    )
    const config = settings.cfAccess
    if (!config) return
    if (
      !config.team ||
      !config.aud ||
      !config.origin ||
      !Array.isArray(config.allow) ||
      config.allow.some((email) => typeof email !== 'string' || !email)
    )
      throw new Error('cfAccess needs team, aud, origin and allow (an array of email addresses)')
    if (new URL(config.origin).origin !== config.origin)
      throw new Error('cfAccess.origin must be a bare origin such as https://ultimate.example.com')
    remove = host.access.allow({
      origin: config.origin,
      verify: async ({ headers }) => {
        const token = headers['cf-access-jwt-assertion']
        if (typeof token !== 'string') return undefined
        const kid = decode(token.split('.')[0] ?? '')?.kid
        // Known keys are re-read every ten minutes too, so a key Cloudflare withdraws stops being trusted.
        if (!keys.some((key) => key.kid === kid) || Date.now() - fetchedAt > 600_000)
          await refresh(config.team)
        const login = verifyToken(token, keys, config)
        return login ? { login } : undefined
      },
    })
  })
  host.onClose(async () => remove?.())
  return defineExtension({ name: 'cf-access' })
}
