# mcp-oauth-gate

A small, self-hostable **MCP OAuth 2.1 authorization server + forward-auth
gateway**. It sits in front of any HTTP service reachable through a
forward-auth-capable reverse proxy (nginx `auth_request`, Traefik
`forwardAuth`, Caddy `forward_auth`, Envoy `ext_authz`) and turns it into a
spec-compliant OAuth 2.1 resource server for MCP clients — device-code
login, Dynamic Client Registration, PKCE, rotating refresh tokens — while
gating access with a flat email allowlist checked against a real identity
provider (any OIDC-compliant provider, or GitHub).

This is the missing middle between "no auth at all" and full multi-tenant
`oauth2-proxy`-style setups: spec-compliant OAuth, single-tenant simplicity.
It's not a competitor to `oauth2-proxy` — that project is a decade of
hardening across thousands of deployments; this is a smaller, more
opinionated tool for "let me and my own devices in."

See [`plan.md`](./plan.md) for the full project plan, phases, and open
decisions.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `BASE_URL` | Public URL this gateway is reached at |
| `RESOURCE_URL` | Canonical URI of the protected resource being guarded |
| `AUTH_PROVIDER` | `oidc` or `github` |
| `OIDC_ISSUER_URL` | Issuer base URL (only when `AUTH_PROVIDER=oidc`) |
| `CLIENT_ID` / `CLIENT_SECRET` | OAuth app credentials from the identity provider |
| `ALLOWED_EMAILS` | Comma-separated allowlist of verified emails |
| `DB_PATH` | SQLite path (default `/data/tokens.db`) |
| `PORT` | Listen port (default `4000`) |

The redirect/callback URL registered with your identity provider must be
exactly `${BASE_URL}/auth/oauth/callback`.

## Running

```
npm install
npm run build
npm start
```

Or via Docker:

```
docker build -t mcp-oauth-gate .
docker run --env-file .env -p 4000:4000 -v gate-data:/data mcp-oauth-gate
```

Published images: `sanderboot/mcp-oauth-gate` on Docker Hub.

## CI/CD

`.github/workflows/docker-publish.yml` builds on every push/PR, and on
pushes to `main` or `v*.*.*` tags also builds and pushes a multi-arch image
to Docker Hub. It needs two repo secrets:

- `DOCKERHUB_USERNAME` — your Docker Hub username
- `DOCKERHUB_TOKEN` — a Docker Hub access token (Docker Hub → Account
  Settings → Security → New Access Token — not your login password)

```
gh secret set DOCKERHUB_USERNAME --body "<your-dockerhub-username>"
gh secret set DOCKERHUB_TOKEN --body "<your-access-token>"
```
