# Bruno smoke tests

A [Bruno](https://www.usebruno.com/) collection that exercises the real
HTTP surface of a **running deployment** — discovery endpoints, DCR,
redirect_uri exact-match enforcement, the forward-auth 401 path through
`auth_request`/`forward_auth`, and a rejected token exchange. It's a
complement to `test/` (fast, in-process, mocks the identity provider), not
a replacement: this one can't complete a real third-party login (that needs
a browser and real credentials), but it validates things the in-process
tests can't — the actual Docker image, real env-var wiring, real reverse-proxy
routing (including that `/verify` is `internal` to nginx and only reachable
via `auth_request`), and a real OIDC discovery call at startup.

## Running it

Point it at any running instance that matches the
[`examples/docker-compose`](../../examples/docker-compose) topology (nginx
in front, `/auth` prefix stripped, protected resource at `/mcp`):

```
cd examples/docker-compose
cp .env.example .env   # AUTH_PROVIDER=oidc with a real OIDC_ISSUER_URL works
                        # even with dummy CLIENT_ID/SECRET — only real login needs real creds
docker compose up -d
cd ../..
pnpm run test:smoke
```

`pnpm run test:smoke` runs the `compose` environment (`baseUrl:
http://localhost:8080`, `authPrefix: /auth`). Override the target with
`--env-var baseUrl=...` for a different host/port.

## Why the requests stop where they do

`06`/`07` register a client and exercise both a rejected and an accepted
`/authorize` request, but the flow can't continue past the redirect to the
identity provider — there's no way to script a real Google/GitHub login
here. `08` instead verifies the _effect_ that matters for a deployment
smoke test: an unauthenticated request to the protected resource is
rejected by nginx's `auth_request` (proving the wiring between nginx and
the gateway's `/verify` endpoint actually works), not just that the
gateway's own `/verify` endpoint returns 401 in isolation (already covered
in `test/integration/oauthFlow.test.ts`).
