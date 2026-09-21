import express from 'express';
import { randomBytes } from 'node:crypto';
import { BASE_URL, AUTH_PATH_PREFIX, RESOURCE_URL, ALLOWED_EMAILS } from './env.js';
import type { Provider } from './provider.js';
import { createDeviceRequest, findByUserCode, approve, pollAndConsume } from './deviceFlow.js';
import { beginAuthorization, completeAuthorization, exchangeCode } from './oauth.js';
import { generateRawToken, hashToken } from './tokens.js';
import {
    findActiveTokenByHash,
    insertToken,
    touchLastUsed,
    insertOAuthClient,
    findOAuthClient,
    insertRefreshToken,
    findRefreshTokenByHash,
    consumeRefreshToken,
    revokeRefreshFamily
} from './db.js';
import { deviceCodeForm, confirmPage, successPage, errorPage } from './html.js';

const RESOURCE_METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource`;

const REDIRECT_URI = `${BASE_URL}${AUTH_PATH_PREFIX}/oauth/callback`;

// OAuth-issued access tokens are short-lived per spec's "SHOULD issue
// short-lived access tokens" — the client is expected to use the paired
// refresh token to get a new one silently. Device-code tokens (no refresh
// token, no client to silently retry) stay non-expiring, unchanged.
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getCookie(req: express.Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
}

function setCsrfCookie(res: express.Response, value: string): void {
    res.setHeader('Set-Cookie', `mog_csrf=${value}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`);
}

/** Builds the Express app for a given identity provider — kept as a pure function (no listen(), no module-level provider selection) so tests can inject a stub Provider and drive the app over HTTP without real network calls. */
export function createApp(provider: Provider): express.Express {
    /** Mints an access/refresh token pair, rotating within `familyId` if given (a refresh, not a fresh login). */
    function issueTokenPair(clientId: string, email: string, familyId?: string) {
        const client = findOAuthClient(clientId);
        const deviceName = `oauth:${client?.client_name ?? clientId}`;
        const now = Date.now();

        const rawAccessToken = generateRawToken();
        const accessTokenId = insertToken(hashToken(rawAccessToken), deviceName, email, new Date(now + ACCESS_TOKEN_TTL_MS).toISOString());

        const rawRefreshToken = generateRawToken();
        insertRefreshToken(
            hashToken(rawRefreshToken),
            familyId ?? randomBytes(16).toString('hex'),
            clientId,
            email,
            accessTokenId,
            new Date(now + REFRESH_TOKEN_TTL_MS).toISOString()
        );

        return {
            access_token: rawAccessToken,
            refresh_token: rawRefreshToken,
            token_type: 'Bearer' as const,
            expires_in: ACCESS_TOKEN_TTL_MS / 1000,
            scope: 'mcp'
        };
    }

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // --- MCP OAuth 2.1 discovery (RFC9728 + RFC8414) ---
    // This origin is both the resource server's front door (proxy/protected
    // service) and its own authorization server — one issuer, no separate AS.

    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
        res.json({
            resource: RESOURCE_URL,
            authorization_servers: [BASE_URL],
            bearer_methods_supported: ['header']
        });
    });

    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
        res.json({
            issuer: BASE_URL,
            authorization_endpoint: `${BASE_URL}${AUTH_PATH_PREFIX}/authorize`,
            token_endpoint: `${BASE_URL}${AUTH_PATH_PREFIX}/token`,
            registration_endpoint: `${BASE_URL}${AUTH_PATH_PREFIX}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: ['mcp']
        });
    });

    // --- Dynamic Client Registration (RFC7591) ---
    // Public clients only (PKCE, no client secret) — registration is
    // intentionally unauthenticated/unmoderated; the actual gate is the
    // identity-provider login + allowlist check in /oauth/callback.

    app.post('/register', (req, res) => {
        const body = req.body ?? {};
        const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u: unknown) => typeof u === 'string') : [];
        if (redirectUris.length === 0) {
            res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
            return;
        }
        const clientId = randomBytes(16).toString('hex');
        const clientName = typeof body.client_name === 'string' && body.client_name ? body.client_name.slice(0, 100) : 'Unnamed MCP client';
        insertOAuthClient(clientId, clientName, redirectUris);
        res.status(201).json({
            client_id: clientId,
            client_name: clientName,
            redirect_uris: redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none'
        });
    });

    // --- Authorization endpoint: hands off to the identity provider, same as /device/authorize ---

    app.get('/authorize', (req, res) => {
        const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : '';
        const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
        const client = findOAuthClient(clientId);
        const registeredRedirects: string[] = client ? JSON.parse(client.redirect_uris) : [];
        if (!client || !registeredRedirects.includes(redirectUri)) {
            // Can't safely redirect back to an unverified redirect_uri — show an error page instead.
            res.status(400).send(errorPage('Unknown client or redirect URI. The MCP client may need to reconnect so it re-registers.'));
            return;
        }

        const clientState = typeof req.query.state === 'string' ? req.query.state : '';
        const codeChallenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : '';
        const isValid = req.query.response_type === 'code' && codeChallenge && req.query.code_challenge_method === 'S256';
        if (!isValid) {
            const err = new URL(redirectUri);
            err.searchParams.set('error', 'invalid_request');
            if (clientState) err.searchParams.set('state', clientState);
            res.redirect(err.toString());
            return;
        }

        const authId = beginAuthorization({ clientId, redirectUri, state: clientState, codeChallenge });
        const csrf = randomBytes(16).toString('hex');
        setCsrfCookie(res, csrf);
        res.redirect(provider.buildAuthUrl(REDIRECT_URI, `oauth:${authId}:${csrf}`));
    });

    // --- Token endpoint: authorization_code + PKCE only (public client, no secret) ---

    app.post('/token', (req, res) => {
        const body = req.body ?? {};

        if (body.grant_type === 'authorization_code') {
            const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier } = body;
            if (
                typeof code !== 'string' ||
                typeof redirectUri !== 'string' ||
                typeof clientId !== 'string' ||
                typeof codeVerifier !== 'string'
            ) {
                res.status(400).json({ error: 'invalid_request' });
                return;
            }
            const result = exchangeCode(code, clientId, redirectUri, codeVerifier);
            if (!result.ok) {
                res.status(400).json({ error: result.error });
                return;
            }
            res.json(issueTokenPair(result.clientId, result.email));
            return;
        }

        if (body.grant_type === 'refresh_token') {
            const { refresh_token: refreshToken, client_id: clientId } = body;
            if (typeof refreshToken !== 'string' || typeof clientId !== 'string') {
                res.status(400).json({ error: 'invalid_request' });
                return;
            }
            const row = findRefreshTokenByHash(hashToken(refreshToken));
            if (!row || row.client_id !== clientId) {
                res.status(400).json({ error: 'invalid_grant' });
                return;
            }
            if (row.revoked_at) {
                // This token was already redeemed once — a legitimate client
                // never presents the same refresh token twice (it always moves
                // to the newest one from rotation), so seeing it again means it
                // leaked. Kill the whole chain rather than just this token.
                revokeRefreshFamily(row.family_id);
                res.status(400).json({ error: 'invalid_grant' });
                return;
            }
            if (row.expires_at < new Date().toISOString()) {
                res.status(400).json({ error: 'invalid_grant' });
                return;
            }
            consumeRefreshToken(row.id);
            res.json(issueTokenPair(row.client_id, row.email, row.family_id));
            return;
        }

        res.status(400).json({ error: 'unsupported_grant_type' });
    });

    // --- Device-code flow: called by MCP clients (VS Code, etc.) ---

    app.post('/device/code', (req, res) => {
        const clientHint = typeof req.body?.client_hint === 'string' ? req.body.client_hint : 'unnamed-device';
        const { deviceCode, userCode, expiresIn, interval } = createDeviceRequest(clientHint);
        const verificationUri = `${BASE_URL}${AUTH_PATH_PREFIX}/device`;
        res.json({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: verificationUri,
            verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
            expires_in: expiresIn,
            interval
        });
    });

    app.post('/device/token', (req, res) => {
        const deviceCode = req.body?.device_code;
        if (typeof deviceCode !== 'string') {
            res.status(400).json({ error: 'invalid_request' });
            return;
        }
        const result = pollAndConsume(deviceCode);
        if (result.status === 'pending') {
            res.status(400).json({ error: 'authorization_pending' });
        } else if (result.status === 'expired') {
            res.status(400).json({ error: 'expired_token' });
        } else {
            res.json({ access_token: result.token, token_type: 'Bearer', device_name: result.deviceName });
        }
    });

    // --- Browser-facing approval flow ---

    app.get('/device', (req, res) => {
        const userCode = typeof req.query.user_code === 'string' ? req.query.user_code.toUpperCase() : '';
        if (!userCode) {
            res.send(deviceCodeForm(''));
            return;
        }
        const found = findByUserCode(userCode);
        if (!found) {
            res.send(deviceCodeForm(userCode, 'That code is invalid or has expired. Ask the device to generate a new one.'));
            return;
        }
        res.send(confirmPage(userCode, found.deviceNameHint));
    });

    app.get('/device/authorize', (req, res) => {
        const userCode = typeof req.query.user_code === 'string' ? req.query.user_code.toUpperCase() : '';
        const found = userCode ? findByUserCode(userCode) : undefined;
        if (!found) {
            res.status(400).send(errorPage('That code is invalid or has expired.'));
            return;
        }
        const csrf = randomBytes(16).toString('hex');
        setCsrfCookie(res, csrf);
        const state = `device:${userCode}:${csrf}`;
        res.redirect(provider.buildAuthUrl(REDIRECT_URI, state));
    });

    // Shared identity-provider callback for both the device-code flow
    // (/device/authorize) and the OAuth 2.1 authorize endpoint (/authorize) —
    // state is prefixed with which flow it belongs to so this one handler can
    // serve both.
    app.get('/oauth/callback', async (req, res) => {
        try {
            const code = req.query.code;
            const state = req.query.state;
            const parts = typeof state === 'string' ? state.split(':') : [];
            if (typeof code !== 'string' || parts.length !== 3) {
                res.status(400).send(errorPage('Malformed callback from the identity provider.'));
                return;
            }
            const [kind, id, csrf] = parts;
            const cookieCsrf = getCookie(req, 'mog_csrf');
            if (!cookieCsrf || cookieCsrf !== csrf) {
                res.status(400).send(errorPage('Could not verify this request (CSRF check failed). Please try again.'));
                return;
            }

            const identity = await provider.exchangeCodeForIdentity(code, REDIRECT_URI);
            if (!identity.emailVerified || !ALLOWED_EMAILS.includes(identity.email)) {
                res.status(403).send(errorPage(`${identity.email} is not authorized to access this service.`));
                return;
            }

            if (kind === 'device') {
                const found = findByUserCode(id);
                if (!found) {
                    res.status(400).send(errorPage('That device code has expired. Ask the device to generate a new one.'));
                    return;
                }
                const rawToken = generateRawToken();
                insertToken(hashToken(rawToken), found.deviceNameHint, identity.email);
                approve(id, rawToken, found.deviceNameHint);
                res.send(successPage(found.deviceNameHint));
                return;
            }

            if (kind === 'oauth') {
                const result = completeAuthorization(id, identity.email);
                if (!result) {
                    res.status(400).send(errorPage('This sign-in request has expired. Please retry from your MCP client.'));
                    return;
                }
                const redirect = new URL(result.redirectUri);
                redirect.searchParams.set('code', result.code);
                if (result.state) redirect.searchParams.set('state', result.state);
                res.redirect(redirect.toString());
                return;
            }

            res.status(400).send(errorPage('Malformed callback from the identity provider.'));
        } catch (err) {
            console.error('[oauth/callback] failed:', err);
            res.status(500).send(errorPage('Sign-in failed. Please try again.'));
        }
    });

    // --- Forward-auth target the reverse proxy calls per-request (must stay unreachable from outside the proxy) ---

    app.get('/verify', (req, res) => {
        // Advertise the protected-resource metadata URL on every 401 so MCP
        // clients that speak the OAuth discovery flow (e.g. VS Code) can find
        // /authorize + /token on their own, instead of just failing silently.
        const unauthorized = () => {
            res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
            res.status(401).end();
        };
        const auth = req.headers.authorization;
        const match = auth?.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            unauthorized();
            return;
        }
        const row = findActiveTokenByHash(hashToken(match[1]));
        if (!row) {
            unauthorized();
            return;
        }
        touchLastUsed(row.id);
        res.setHeader('X-Device-Name', row.device_name);
        res.status(200).end();
    });

    app.get('/healthz', (_req, res) => res.status(200).send('ok'));

    return app;
}
