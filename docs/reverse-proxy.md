# Putting this behind a reverse proxy

`mcp-oauth-gate` is a **sidecar**, not a standalone proxy — it never
terminates client traffic itself. Your reverse proxy sends it one
subrequest per incoming request (`/verify`) to ask "is this bearer token
good?", and routes three route groups:

| Route(s) | Behind `auth_request`/`forwardAuth`? | Notes |
|---|---|---|
| `/mcp` (or wherever `RESOURCE_URL` points) | **Yes** | The actual protected service |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | No | Must be reachable without a token — clients fetch these to learn how to get one |
| `/auth/*` (login, device-code, DCR, token endpoint) | No | A client doesn't have a token yet when it starts either flow |

The worked example below assumes the gateway is reachable at
`mcp-oauth-gate:4000` and the protected service at `protected-service:80`
(matching [`examples/docker-compose`](../examples/docker-compose)) — swap in
your real service names/ports.

## nginx

Uses [`auth_request`](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html).
A complete, verified config is at
[`examples/docker-compose/nginx.conf`](../examples/docker-compose/nginx.conf); the
core pattern:

```nginx
location = /verify {
    internal;
    proxy_pass http://mcp-oauth-gate:4000/verify;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Authorization $http_authorization;
}

location /mcp {
    auth_request /verify;
    auth_request_set $device_name $upstream_http_x_device_name;
    proxy_set_header X-Device-Name $device_name;
    proxy_pass http://protected-service:80/;
}

location /auth/ {
    rewrite ^/auth/(.*)$ /$1 break;
    proxy_pass http://mcp-oauth-gate:4000;
}
```

nginx's `auth_request` module automatically forwards the `WWW-Authenticate`
header from `/verify`'s 401 response onto the client response — don't set
it again in the `/mcp` block, it'll just duplicate.

## Traefik

Uses [`forwardAuth`](https://doc.traefik.io/traefik/middlewares/http/forwardauth/)
via labels (or the equivalent dynamic-config YAML):

```yaml
services:
  protected-service:
    labels:
      - "traefik.http.routers.mcp.rule=PathPrefix(`/mcp`)"
      - "traefik.http.routers.mcp.middlewares=mcp-auth"
      - "traefik.http.middlewares.mcp-auth.forwardauth.address=http://mcp-oauth-gate:4000/verify"
      - "traefik.http.middlewares.mcp-auth.forwardauth.authResponseHeaders=X-Device-Name,WWW-Authenticate"

  mcp-oauth-gate:
    labels:
      # Discovery + /auth/* stay unauthenticated, same as the nginx example.
      - "traefik.http.routers.oauth-discovery.rule=PathPrefix(`/.well-known/oauth-`)"
      - "traefik.http.routers.oauth-auth.rule=PathPrefix(`/auth/`)"
      - "traefik.http.middlewares.strip-auth-prefix.stripprefix.prefixes=/auth"
      - "traefik.http.routers.oauth-auth.middlewares=strip-auth-prefix"
```

`authResponseHeaders` must list `WWW-Authenticate` explicitly — unlike
nginx, Traefik's `forwardAuth` doesn't forward it by default, so a 401
without it will leave OAuth-discovery-aware clients unable to find
`/authorize` on their own.

## Caddy

Uses [`forward_auth`](https://caddyserver.com/docs/caddyfile/directives/forward_auth):

```caddyfile
your-domain.example {
    handle /.well-known/oauth-* {
        reverse_proxy mcp-oauth-gate:4000
    }

    handle_path /auth/* {
        reverse_proxy mcp-oauth-gate:4000
    }

    handle /mcp* {
        forward_auth mcp-oauth-gate:4000 {
            uri /verify
            copy_headers X-Device-Name
        }
        reverse_proxy protected-service:80
    }
}
```

Caddy's `forward_auth` does forward `WWW-Authenticate` from the auth
subrequest's 401 by default, same as nginx.

## Envoy

Use [`ext_authz`](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_authz_filter)
pointed at `mcp-oauth-gate:4000/verify` as an HTTP authorization service,
with `Authorization` in `allowed_headers_to_add` and `WWW-Authenticate` /
`X-Device-Name` in the response headers passed back to the client. Envoy's
config is verbose enough that a worked example isn't included here yet —
the nginx/Traefik examples above show the same three-route-group shape
you're translating into Envoy's config model.
