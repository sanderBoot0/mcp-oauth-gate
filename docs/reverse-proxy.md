# Putting this behind your own reverse proxy (for TLS)

`mcp-oauth-gate` bundles nginx and does its own forward-auth wiring
internally — there's no `auth_request`/`forwardAuth` config to write
against it. The only reason to put another reverse proxy in front of it is
**TLS termination** (the container is HTTP-only) or to consolidate several
services behind one entry point you already run. In both cases it's a
**plain reverse proxy** pointed at the container's port 80 — nothing
gateway-specific to configure, since the container already handles
`/verify`, discovery, and the OAuth endpoints internally.

The examples below assume the container is reachable at
`mcp-oauth-gate:80` (matching [`examples/docker-compose`](../examples/docker-compose))
and terminate TLS for `auth.example.com` — swap in your real hostname.

## nginx

```nginx
server {
    listen 443 ssl;
    server_name auth.example.com;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_set_header Host $host;
        proxy_pass http://mcp-oauth-gate:80;
    }
}
```

## Traefik

```yaml
services:
    mcp-oauth-gate:
        labels:
            - 'traefik.http.routers.gate.rule=Host(`auth.example.com`)'
            - 'traefik.http.routers.gate.tls.certresolver=<your-resolver>'
            - 'traefik.http.services.gate.loadbalancer.server.port=80'
```

## Caddy

```caddyfile
auth.example.com {
    reverse_proxy mcp-oauth-gate:80
}
```

Caddy handles TLS (via automatic ACME) with no further config.

## If you're migrating from an older forward-auth-based setup

Earlier versions of this project shipped as a sidecar you wired up
yourself against your own reverse proxy's `auth_request`/`forwardAuth`
support (nginx, Traefik, Caddy, Envoy). That's no longer how this works —
nginx is bundled in, and `UPSTREAM_URL` replaces hand-written
`proxy_pass`/routing config. If you had a working forward-auth setup from
before, retire it and point whatever's in front of it (if anything) at
this container's port 80 instead, per the examples above.
