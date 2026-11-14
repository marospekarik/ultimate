import { expect, it } from 'vitest'
import { admit, deviceOf, loopbackAuthority, loopbackOrigin } from '../server/request-security.ts'

it.each(['127.0.0.1', 'localhost', '[::1]', 'ultimate.localhost', 'preview.ultimate.localhost'])(
  'admits direct loopback host and origin %s on the listening port',
  async (host) => {
    expect(loopbackAuthority(`${host}:4799`, '4799')).toBe(true)
    expect(loopbackOrigin(`http://${host}:4799`, '4799')).toBe(true)
    expect(
      await admit(
        { headers: { host: `${host}:4799`, origin: `http://${host}:4799` } },
        '4799',
        new Set(),
      ),
    ).toEqual({})
  },
)

it.each([
  'evil.com:4799',
  'localhost.evil.com:4799',
  'ultimatelocalhost:4799',
  'ultimate.localhost:4800',
])('rejects foreign or wrong-port authority %s and its origin', async (host) => {
  expect(loopbackAuthority(host, '4799')).toBe(false)
  expect(loopbackOrigin(`http://${host}`, '4799')).toBe(false)
  expect(await admit({ headers: { host } }, '4799', new Set())).toBeUndefined()
  expect(
    await admit(
      { headers: { host: 'ultimate.localhost:4799', origin: `http://${host}` } },
      '4799',
      new Set(),
    ),
  ).toBeUndefined()
})

it('does not admit forwarded localhost subdomains', async () => {
  expect(
    await admit(
      { headers: { host: 'ultimate.localhost:4799', 'x-forwarded-for': '127.0.0.1' } },
      '4799',
      new Set(),
    ),
  ).toBeUndefined()
})

it('labels a request by its browser, with the login of the rule that admitted it', () => {
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'
  expect(deviceOf({ 'user-agent': iphone }, {})).toEqual({ device: 'phone safari' })
  expect(
    deviceOf({ 'user-agent': linux }, { login: 'me@example.com', address: '100.64.0.2' }),
  ).toEqual({ device: 'desktop chrome', login: 'me@example.com', address: '100.64.0.2' })
  // The request's own identity headers are a claim: only the admitting rule's identity counts.
  expect(
    deviceOf(
      {
        'user-agent': linux,
        'tailscale-user-login': 'me@example.com',
        'x-forwarded-for': '1.2.3.4',
      },
      {},
    ),
  ).toEqual({ device: 'desktop chrome' })
  expect(deviceOf({}, {})).toEqual({ device: 'desktop other' })
})
