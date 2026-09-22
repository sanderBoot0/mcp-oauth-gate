# Contributing

This covers building, testing, and maintaining `mcp-oauth-gate` itself.
If you just want to run it, see the main [README](./README.md) instead.

## Setup

```sh
npm install -g corepack@0.36.0   # Node 25+ no longer bundles it — see note below
corepack enable
pnpm install
pnpm run build
```

`pnpm start` (`node dist/main.js`) needs `BASE_URL`, `RESOURCE_URL`,
`AUTH_PROVIDER`, `CLIENT_ID`, `CLIENT_SECRET`, and `ALLOWED_EMAILS` set —
plus `OIDC_ISSUER_URL` too if `AUTH_PROVIDER=oidc` (the default) — and
it doesn't load `.env` itself, so `set -a && source .env && set +a`
first (plain `export $(cat .env | xargs)` breaks on `.env.example`'s own
comment lines — confirmed: it throws `not a valid identifier` for every
`#` comment). `pnpm run dev` needs the same. For actually exercising the
gateway rather than just building it, the
[docker-compose quickstart](./README.md#quickstart) is the easier path —
it has all of this wired up already.

## Testing

```sh
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
instance — the real Docker image, bundled nginx and all — rather than the
in-process app the tests above use. See its own
[README](./bruno/mcp-oauth-gate/README.md) for what it covers and why.

`docker-compose.yml` points at the published `sanderboot/mcp-oauth-gate:latest`
image by default — build and tag it locally first (as CI does), or
`docker compose up` will happily test an old published image instead of
your changes:

```sh
docker build -t sanderboot/mcp-oauth-gate:latest .
cd examples/docker-compose && cp .env.example .env && docker compose up -d
cd ../.. && pnpm run test:smoke
```

CI runs this against every pull request, and every push to `master` or a
`v*.*.*` tag — see [CI/CD](#cicd) below.

## Linting, formatting, type-checking

```sh
pnpm run lint          # eslint
pnpm run format        # prettier --write
pnpm run format:check  # prettier --check (used in CI)
pnpm run typecheck     # tsc --noEmit, covering src/ and test/
```

All dependency versions (including `typescript`) are pinned exact in
`package.json` rather than range-specified, so `pnpm install` always
resolves the same tree; use `pnpm outdated` to see what's behind.
pnpm blocks lifecycle install scripts by default, regardless of what they
do — `better-sqlite3` needs one to compile its native addon from source,
`esbuild` to fetch its prebuilt platform binary, and `protobufjs` to run a
pure-JS compatibility check. That allowlist is recorded in
`pnpm-workspace.yaml` (`allowBuilds`), not something you need to approve
by hand.

**On TypeScript 7:** `typescript` is pinned to the latest **6.x**, not the
newer TypeScript 7 native compiler. `typescript-eslint` (the TS-aware
linting engine `pnpm run lint` depends on) hard-refuses to run against TS
7 as of this writing — see
[typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940).
Revisit once that support lands.

Type assertions (`x as Y`) are banned via
`@typescript-eslint/consistent-type-assertions` — `as const` is still
fine, since it narrows a literal rather than asserting a different type.
Anything that used to need a cast (sqlite rows, external HTTP JSON,
`req.body`/`req.query`) is validated with a [zod](https://zod.dev/) schema
instead.

## Package manager

This repo uses [pnpm](https://pnpm.io/), pinned via `packageManager` in
`package.json` — `corepack enable` plus `pnpm install` fetches the exact
pinned version automatically. Not npm/yarn: `package-lock.json`/
`yarn.lock` aren't used, and mixing lockfiles will just confuse whichever
tool runs second.

**On Corepack:** it shipped bundled with Node ≥16.9 through Node 24, but
Node 25.0.0 stopped distributing it entirely
([nodejs/node#57617](https://github.com/nodejs/node/pull/57617)) — on
Node ≥25, `corepack enable` fails with "command not found" until you
`npm install -g corepack@<version>` first, which is why the Setup section
above and this project's own `Dockerfile` (Node 26) both install it
explicitly before enabling it. CI sidesteps the question entirely: it
installs pnpm directly via `pnpm/action-setup` (reading the pinned
version from `packageManager` in `package.json`) rather than going
through Corepack at all.

## CI/CD

`.github/workflows/docker-publish.yml` builds on every pull request, and
every push to `master` or a `v*.*.*` tag (format check, lint, typecheck,
build, test), then builds the image and runs the Bruno smoke tests against
the real docker-compose stack, and on pushes to `master` or `v*.*.*` tags
also builds and pushes a multi-arch image to Docker Hub. It needs:

- `DOCKERHUB_USERNAME` — a repo **variable** (not a secret — it's not
  sensitive) with your Docker Hub username
- `DOCKERHUB_TOKEN` — a repo **secret** holding a Docker Hub access token
  (Docker Hub → Account Settings → Security → New Access Token — not your
  login password)

```sh
gh variable set DOCKERHUB_USERNAME --body "<your-dockerhub-username>"
gh secret set DOCKERHUB_TOKEN --body "<your-access-token>"
```

The `docker` build-and-push job only runs on `push` events (to `master` or
a `v*.*.*` tag) — it's gated with `if: github.event_name == 'push'`, so
opening or updating a pull request never logs into Docker Hub or pushes an
image, only the format/lint/typecheck/build/test and smoke-test jobs run.

### Dependabot auto-merge

`.github/dependabot.yml` opens weekly PRs for npm (devDependencies grouped
into one, patch/minor only — a major bump gets its own separate PR),
Docker base image, and GitHub Actions updates.
`.github/workflows/dependabot-auto-merge.yml` approves and enables
auto-merge for patch/minor Dependabot PRs; major bumps are always left for
manual review (verify this by checking the PR has no review and
`auto_merge: null` if in doubt — the job can show `success` overall even
when its approval step correctly skipped a major bump).

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

When reviewing a Dependabot PR in the GitHub UI, the "Review changes"
button only appears at the bottom of the **Files changed** tab (not on
Conversation) — for a lockfile-heavy diff you may need to let it finish
loading before it renders.
