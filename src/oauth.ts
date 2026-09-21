import { randomBytes, createHash } from 'node:crypto';

const AUTH_CODE_EXPIRY_MS = 60 * 1000;
const AUTHORIZE_REQUEST_EXPIRY_MS = 10 * 60 * 1000;

interface PendingAuthorization {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    expiresAt: number;
}

interface IssuedCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    email: string;
    expiresAt: number;
}

// Ephemeral, in-memory like deviceFlow.ts's maps — losing this on restart
// just means an in-progress sign-in has to be retried. Long-lived state
// (registered clients, issued access tokens) lives in sqlite (db.ts).
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const issuedCodes = new Map<string, IssuedCode>();

export function beginAuthorization(params: Omit<PendingAuthorization, 'expiresAt'>): string {
    const authId = randomBytes(16).toString('hex');
    pendingAuthorizations.set(authId, { ...params, expiresAt: Date.now() + AUTHORIZE_REQUEST_EXPIRY_MS });
    return authId;
}

function getPendingAuthorization(authId: string): PendingAuthorization | undefined {
    const pending = pendingAuthorizations.get(authId);
    if (!pending || Date.now() > pending.expiresAt) {
        pendingAuthorizations.delete(authId);
        return undefined;
    }
    return pending;
}

/** Called once GitHub has verified the user's identity for a pending /authorize request. */
export function completeAuthorization(authId: string, email: string): { redirectUri: string; code: string; state: string } | undefined {
    const pending = getPendingAuthorization(authId);
    if (!pending) return undefined;
    pendingAuthorizations.delete(authId);

    const code = randomBytes(32).toString('hex');
    issuedCodes.set(code, {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        email,
        expiresAt: Date.now() + AUTH_CODE_EXPIRY_MS
    });
    return { redirectUri: pending.redirectUri, code, state: pending.state };
}

export type ExchangeResult = { ok: true; email: string; clientId: string } | { ok: false; error: string };

/** RFC7636 PKCE verification (S256 only) + single-use code redemption. */
export function exchangeCode(code: string, clientId: string, redirectUri: string, codeVerifier: string): ExchangeResult {
    const issued = issuedCodes.get(code);
    issuedCodes.delete(code); // single-use regardless of outcome

    if (!issued || Date.now() > issued.expiresAt) {
        return { ok: false, error: 'invalid_grant' };
    }
    if (issued.clientId !== clientId || issued.redirectUri !== redirectUri) {
        return { ok: false, error: 'invalid_grant' };
    }
    const verifierHash = createHash('sha256').update(codeVerifier).digest('base64url');
    if (verifierHash !== issued.codeChallenge) {
        return { ok: false, error: 'invalid_grant' };
    }
    return { ok: true, email: issued.email, clientId: issued.clientId };
}
