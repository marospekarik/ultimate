import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { verifyToken } from '../extensions/cf-access/server.ts'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keys = [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }]
const config = { team: 'my-team', aud: 'tag1', allow: ['Guest@Example.com'] }
const now = 1_000_000
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

function token(claims: object = {}, { kid = 'k1', alg = 'RS256', key = privateKey } = {}) {
  const body = {
    iss: 'https://my-team.cloudflareaccess.com',
    aud: ['tag1'],
    email: 'guest@example.com',
    exp: now + 60,
    ...claims,
  }
  const signed = `${b64({ alg, kid })}.${b64(body)}`
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`
}
const check = (jwt: string) => verifyToken(jwt, keys, config, now)

it('admits a signed token for an allowed email, ignoring case', () => {
  expect(check(token())).toBe('guest@example.com')
})

it.each([
  ['another email', token({ email: 'other@example.com' })],
  ['another audience', token({ aud: ['tag2'] })],
  ['another issuer', token({ iss: 'https://evil.cloudflareaccess.com' })],
  ['an expired token', token({ exp: now - 1 })],
  ['an unknown key id', token({}, { kid: 'k2' })],
  ['a signature by another key', token({}, { key: other.privateKey })],
  ['a header that names another algorithm', token({}, { alg: 'none' })],
  [
    'a body changed after signing',
    token().replace(/\.[^.]+\./, `.${b64({ email: 'guest@example.com', aud: 'tag1' })}.`),
  ],
])('refuses %s', (_name, jwt) => {
  expect(check(jwt)).toBeUndefined()
})
