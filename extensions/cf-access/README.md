Admit a guest who logged in through Cloudflare Access, for an Ultimate reached by Cloudflare Tunnel instead of Tailscale. Off by default.

## Settings

Enable it and set the guest in `~/.ultimate/settings.json` (only user settings count; project settings never admit anyone):

```json
{
  "extensions": { "enable": ["cf-access"] },
  "cfAccess": {
    "team": "my-team",
    "aud": "<the Access application's AUD tag>",
    "origin": "https://ultimate.example.com",
    "allow": ["guest@example.com"]
  }
}
```

Without `cfAccess` the extension does nothing. Point the tunnel (`cloudflared`) at the local supervisor port and put an Access application with a one-time-PIN policy for the same address on `origin`.

## Admission

Cloudflare Access adds a signed `Cf-Access-Jwt-Assertion` to every request it forwards. A request is admitted when:

- the Host is `origin`'s and any Origin equals it (the core's rules for every remote client, including fetch-metadata checks and forwarded-header handling, apply unchanged);
- the token is signed RS256 by a key in `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (fetched when a key id is unknown and every ten minutes, at most once a minute, so a withdrawn key stops being trusted);
- its issuer is that team, its audience contains `aud`, it has not expired, and its email is in `allow`.

A forged header fails the signature check; a copied one stays valid until the token expires. Revoke a guest by removing the email from `allow` (applies on save) and from the Access policy; sessions end at the token's expiry, so also revoke the user's sessions in Cloudflare for an immediate cut-off.

The local listener stays loopback-only: anything on the same machine can reach it without the tunnel, so give the machine to Ultimate and `cloudflared` alone.
