# Bellwether Tailscale sidecar pilot

Bellwether has two tailnet ingress paths during the pilot:

- Preferred per-application identity: `https://bellwether.tail49736b.ts.net`
- Existing host fallback: `https://elrics-mac-mini.tail49736b.ts.net:8443`

The `tailscale` service runs the official Tailscale container in userspace
mode. It terminates tailnet HTTPS and proxies to `http://server:3000` over the
private Compose network. Only the existing fallback binds a host port, and it
binds loopback only.

## Identity lifecycle

The `tailscale-state` volume stores the Bellwether node identity. Preserve this
volume across image updates and ordinary container recreation. Losing it causes
a new tailnet node registration.

`TS_AUTH_ONCE=true` prevents reauthentication after state exists. Initial pilot
registration uses Tailscale's interactive device-authorization URL, so no
reusable credential is stored in Compose. Before adopting this pattern broadly,
use a purpose-scoped OAuth client or another automated, tagged credential
strategy.

## Verification

```sh
docker compose ps
docker compose logs tailscale
curl --fail https://bellwether.tail49736b.ts.net/healthz
```

The old `:8443` route should remain working until the sidecar has survived a
restart and tailnet access policy has been tested.
