---

# mcp-oauth-gate — Project Plan

## What this is

A small, self-hostable **MCP OAuth 2.1 authorization server + auth gateway**,
extracted and generalized from the `auth-service` built for a personal
Obsidian-vault MCP server. It bundles its own reverse proxy (nginx) and
sits directly in front of any HTTP service, turning it into a proper
OAuth 2.1 resource server for MCP clients — device-code login,
Dynamic Client Registration, PKCE, rotating refresh tokens — while gating
who's allowed in with a flat email allowlist against a real identity
provider (Google, Microsoft/Outlook, GitHub, or anything OIDC-compliant).
One container to run, one env var (`UPSTREAM_URL`) to point it at the
service being protected — no separate reverse proxy to configure.

> **Architecture pivot (post-v0.1.0):** the original plan below assumed a
> forward-auth *sidecar* — the user's own reverse proxy calls this
> service's `/verify` endpoint and does its own routing/proxying. That
> shipped and worked, but real usage showed the actual adoption blocker
> was exactly what "Open decision #1" below flagged as the thing to watch
> for: two containers plus hand-written nginx config was real, avoidable
> friction. nginx is now bundled inside this project's own image instead;
> see [`docs/reverse-proxy.md`](./docs/reverse-proxy.md) for what's left
> for a user to configure (just TLS termination, optionally) and the
> [README](./README.md) for the current architecture diagram. Phases 0-4
> below are historical record of how v0.1.0 got built, not a description
> of the current sidecar-free architecture.

**The gap this fills**: most self-hosted MCP servers today ship with either
no auth or a single static bearer token. Full multi-tenant OAuth (what
`oauth2-proxy` and friends target) is real overkill for "let me and my own
devices in." This is the missing middle: spec-compliant OAuth, single-tenant
simplicity.

**Explicitly not a competitor to `oauth2-proxy`** — that project is a decade
of hardening across thousands of deployments, multi-tenant, multi-provider,
with its own maintainer team. This is a smaller, more opinionated tool for a
narrower job. Say so in the README; don't oversell it.

## Non-goals (v0)

- **Multi-tenant / per-user client registries.** Access control is a flat
  email allowlist. If real multi-tenancy is ever needed, that's a different
  project, not a v1 feature to grow into accidentally.
- **Pluggable storage backends.** SQLite only. Revisit only if someone
  actually needs multi-replica deployment — don't build the abstraction
  speculatively.
- **Non-OAuth identity** (passwords, magic links, WebAuthn). OAuth/OIDC only.

## Architecture (current, post-pivot)

                                   ┌─────────────────────────────┐
  MCP client ─── HTTPS request ───►│        mcp-oauth-gate        │
                                   │  (nginx + Node, one          │
                                   │   container, bundled)        │
                                   └───┬───────────────────┬─────┘
                                       │                   │
                              OIDC discovery /      proxies through,
                              GitHub REST           once authenticated
                                       │                   │
                                       ▼                   ▼
                              ┌────────────────┐  ┌──────────────────┐
                              │ Google / Okta /│  │  protected        │
                              │ Outlook / GitHub│  │  service          │
                              │ / any OIDC IdP │  │  (UPSTREAM_URL,   │
                              └────────────────┘  │  any HTTP, not    │
                                                   │  just MCP)        │
                                                   └──────────────────┘

The gateway owns everything: OAuth 2.1 discovery endpoints, DCR,
`/authorize`, `/token` (with PKCE + refresh rotation), the device-code
fallback flow, the forward-auth check, *and* the proxying to
`UPSTREAM_URL` — nginx does that internally, not a reverse proxy the user
brings. See the architecture pivot note above and
[`docs/reverse-proxy.md`](./docs/reverse-proxy.md) for what (if anything)
still goes in front of this container.

## Provider model

Two provider "kinds," not N bespoke integrations:

1. **Generic OIDC** (`AUTH_PROVIDER=oidc` + `OIDC_ISSUER_URL`) — covers
   Google, Microsoft/Outlook (Azure AD), Okta, Auth0, Keycloak, Authentik,
   GitLab, and anything else OIDC-compliant. Discovery
   (`<issuer>/.well-known/openid-configuration`) hands back the authorize
   endpoint, token endpoint, and JWKS automatically — one code path for
   every provider in this bucket, verified via JWT/JWKS (already basically
   how the current `google.ts` works; this generalizes it).
2. **GitHub** (`AUTH_PROVIDER=github`) — hardcoded, because GitHub's OAuth
   isn't OIDC-compliant (no `id_token`, needs a `/user/emails` REST call
   instead of JWT verification). Stays a first-class special case.

Config surface:

AUTH_PROVIDER=oidc | github
OIDC_ISSUER_URL=...          # only when AUTH_PROVIDER=oidc
CLIENT_ID=...
CLIENT_SECRET=...
ALLOWED_EMAILS=a@example.com,b@example.com
BASE_URL=https://auth.example.com
RESOURCE_URL=https://mcp.example.com/mcp   # the thing being protected — see below
DB_PATH=/data/tokens.db

`RESOURCE_URL` generalizes what's currently hardcoded to `${BASE_URL}/mcp`
— the protected-resource identifier (RFC9728) should be whatever
the actual downstream service's canonical URI is, not assumed to always be
an MCP endpoint at a fixed path.

## Phases

**Phase 0 — Extract & rename.** Lift `auth-service/` into its own repo.
Strip vault-specific naming (`second-brain`, `sannyboy131@gmail.com`
references, etc.) from code/docs. Get it building and running standalone,
still hardcoded to whichever single provider was last configured — no
behavior change yet, just decoupled from the vault repo.

**Phase 1 — Generalize providers.** Implement the OIDC-discovery-based
generic provider; define a small `Provider` interface (`buildAuthUrl`,
`exchangeCodeForIdentity`) that both the OIDC and GitHub implementations
satisfy. Add `AUTH_PROVIDER` switching. Manually verify against at least
Google and one non-Google OIDC IdP (e.g. a local Keycloak or Authentik
instance) to make sure "generic OIDC" isn't secretly "Google-shaped OIDC."

**Phase 2 — Generalize the protected resource.** Replace the hardcoded
`/mcp` resource path with `RESOURCE_URL`. Confirm the protected-resource
metadata and `WWW-Authenticate` header both reflect it correctly.

**Phase 3 — Real test suite.** Nothing here has automated tests yet — this
session's verification was all ad hoc scripts. Build:
- A minimal mock OIDC IdP (and a mock GitHub) for tests to run against
  without real credentials or network calls.
- Unit tests: PKCE verify/reject, refresh rotation, reuse-detection kill-chain
  (all logic that was manually verified this session and needs to become
  permanent regression coverage), DCR validation, redirect_uri exact-match
  enforcement.
- Integration test: full `register → authorize → token → verify → refresh
  → reuse-detected` chain over real HTTP against a running instance.
- Wire CI (GitHub Actions) to run this on every push.

**Phase 4 — Docs & security pass.** README with a docker-compose quickstart;
a "point this at any reverse proxy" doc with concrete nginx AND
Traefik/Caddy forward-auth examples; an explicit security-model doc stating
the single-tenant assumption, that DCR is intentionally unauthenticated (and
why that's fine *only* under the allowlist-gated model), and what's out of
scope. Get at least one outside pair of eyes on the auth flow before tagging
anything `v0.1.0` — this handles real credentials, it deserves it.

**Phase 5 — Publish.** Primary distribution: a versioned Docker image (GHCR
or Docker Hub), configured entirely by env vars, matching how `oauth2-proxy`
itself ships. Optional/secondary: publish the provider + token logic as an
npm package for anyone embedding it programmatically rather than running it
as a sidecar.

**Phase 6 (stretch, only if there's real demand)** — ~~standalone
reverse-proxy mode (no external nginx required)~~ **done, see the
architecture pivot note above** — pluggable storage, additional
convenience provider presets (e.g. a `microsoft` alias that's really just
`oidc` with the right issuer pre-filled so people don't have to look it up)
remain stretch goals.

## Open decisions (resolve before or during Phase 0)

1. ~~**Sidecar (forward-auth) vs. bundled proxy.**~~ **Resolved, reversed:**
   "no nginx needed" *was* the actual adoption blocker this was meant to
   watch for — two containers plus hand-written nginx config was real
   friction. nginx is now bundled into this project's own image; see the
   architecture pivot note at the top of this document.
2. **License.** Not decided — MIT is the path of least friction if the goal
   is adoption; note `oauth2-proxy` itself is Apache-2.0 if consistency with
   that ecosystem matters to you.
3. **Package name.** TBD — needs to not collide on npm/Docker Hub/GHCR.
4. **Keep the device-code flow?** Recommend yes — not every MCP client
   supports OAuth discovery yet, and it's a working, already-tested fallback
   (mirrors `gh auth login`). Don't drop it just because OAuth 2.1 exists now.

## Definition of done for v0.1.0

- [ ] Runs as a single Docker container, config entirely via env vars
- [ ] Supports `AUTH_PROVIDER=oidc` (any issuer) and `AUTH_PROVIDER=github`
- [ ] `RESOURCE_URL` configurable, not hardcoded to `/mcp`
- [ ] Automated test suite (unit + integration) running in CI
- [ ] README with a working docker-compose quickstart, tested from scratch
- [ ] Security-model doc, reviewed by someone other than the sole author
- [ ] Tagged release, published image

---
