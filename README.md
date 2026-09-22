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

| Variable                      | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `BASE_URL`                    | Public URL this gateway is reached at                 |
| `RESOURCE_URL`                | Canonical URI of the protected resource being guarded |
| `AUTH_PROVIDER`               | `oidc` or `github`                                    |
| `OIDC_ISSUER_URL`             | Issuer base URL (only when `AUTH_PROVIDER=oidc`)      |
| `CLIENT_ID` / `CLIENT_SECRET` | OAuth app credentials from the identity provider      |
| `ALLOWED_EMAILS`              | Comma-separated allowlist of verified emails          |
| `DB_PATH`                     | SQLite path (default `/data/tokens.db`)               |
| `PORT`                        | Listen port (default `4000`)                          |

The redirect/callback URL registered with your identity provider must be
exactly `${BASE_URL}/auth/oauth/callback`.

## Running

```
pnpm install
pnpm run build
pnpm start
```

Or via Docker:

```
docker build -t mcp-oauth-gate .
docker run --env-file .env -p 4000:4000 -v gate-data:/data mcp-oauth-gate
```

Published images: `sanderboot/mcp-oauth-gate` on Docker Hub.

### Docker Compose quickstart

[`examples/docker-compose`](./examples/docker-compose) is a complete,
verified stack: the gateway, an nginx forward-auth config wired to it, and
a placeholder protected service (`httpbin`) to swap for your real one.

```
cd examples/docker-compose
cp .env.example .env   # fill in AUTH_PROVIDER, CLIENT_ID/SECRET, ALLOWED_EMAILS
docker compose up
```

Then `curl http://localhost:8080/mcp` should 401 with a `WWW-Authenticate`
header pointing at the discovery endpoint — sign in through your identity
provider to get a token. See
[`docs/reverse-proxy.md`](./docs/reverse-proxy.md) for the same pattern
with Traefik, Caddy, or Envoy instead of nginx, and
[`docs/security-model.md`](./docs/security-model.md) for what this gateway
does and doesn't defend against before you deploy it for real.

## Testing

```
pnpm test
```

Unit tests cover PKCE verification, refresh-token rotation and
reuse-detection, and both providers (GitHub against a mocked `fetch`, OIDC
against a minimal mock IdP with real discovery/JWKS/signed tokens).
Integration tests drive the full `register → authorize → token → verify →
refresh → reuse-detected` chain over HTTP.

### Smoke tests against a real deployment

[`bruno/mcp-oauth-gate`](./bruno/mcp-oauth-gate) is a
[Bruno](https://www.usebruno.com/) collection that exercises a **running**
instance — the real Docker image behind real nginx forward-auth routing —
rather than the in-process app the tests above use. See its own
[README](./bruno/mcp-oauth-gate/README.md) for what it covers and why.

```
cd examples/docker-compose && cp .env.example .env && docker compose up -d
cd ../.. && pnpm run test:smoke
```

CI runs this against every push and PR (see below), not just on release.

## Linting, formatting, type-checking

```
pnpm run lint          # eslint
pnpm run format        # prettier --write
pnpm run format:check  # prettier --check (used in CI)
pnpm run typecheck     # tsc --noEmit, covering src/ and test/
```

All dependency versions (including `typescript`) are pinned exact in
`package.json` rather than range-specified, so `pnpm install` always
resolves the same tree; use `pnpm outdated` to see what's behind.
`better-sqlite3` and `esbuild` need to run native build scripts, which
pnpm blocks by default — that allowlist is recorded in
`pnpm-workspace.yaml` (`allowBuilds`), not something you need to approve
by hand.

**On TypeScript 7:** `typescript` is pinned to the latest **6.x**
(`6.0.3`), not the newer TypeScript 7 native compiler. `typescript-eslint`
(the TS-aware linting engine `pnpm run lint` depends on) hard-refuses to
run against TS 7 as of this writing — see
[typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).
Revisit once that support lands.

## CI/CD

`.github/workflows/docker-publish.yml` builds on every push/PR (format
check, lint, typecheck, build, test), then builds the image and runs the
Bruno smoke tests against the real docker-compose stack, and on pushes to
`master` or `v*.*.*` tags also builds and pushes a multi-arch image to
Docker Hub. It needs:

- `DOCKERHUB_USERNAME` — a repo **variable** (not a secret — it's not
  sensitive) with your Docker Hub username
- `DOCKERHUB_TOKEN` — a repo **secret** holding a Docker Hub access token
  (Docker Hub → Account Settings → Security → New Access Token — not your
  login password)

```
gh variable set DOCKERHUB_USERNAME --body "<your-dockerhub-username>"
gh secret set DOCKERHUB_TOKEN --body "<your-access-token>"
```

### Dependabot auto-merge

`.github/dependabot.yml` opens weekly PRs for npm (devDependencies grouped
into one, patch/minor only — a major bump gets its own separate PR),
Docker base image, and GitHub Actions updates.
`.github/workflows/dependabot-auto-merge.yml` approves and enables
auto-merge for patch/minor Dependabot PRs; major bumps are always left for
manual review.

**"Enable auto-merge" only queues the merge for once CI passes — it
doesn't skip CI.** But that's only true if `master` actually has required
status checks configured; without them, GitHub merges as soon as the PR is
otherwise mergeable, whether or not `build-check`/`smoke-test` finished.
Two one-time repo settings, done through the GitHub UI (not something this
workflow can set for you):

1. **Settings → General → Pull Requests → check "Allow auto-merge".**
2. **Settings → Branches → add a branch protection rule for `master`** with
   "Require status checks to pass before merging" and both `build-check`
   and `smoke-test` selected as required checks.

Without step 2, treat "auto-merge enabled" as "will merge shortly" rather
than "will merge once green."

## Package manager

This repo uses [pnpm](https://pnpm.io/), pinned via `packageManager` in
`package.json` — run `corepack enable` once (ships with Node ≥16.9) and
`pnpm install` will fetch the exact pinned pnpm version automatically. Not
npm/yarn: `package-lock.json`/`yarn.lock` aren't used, and mixing lockfiles
will just confuse whichever tool runs second.
