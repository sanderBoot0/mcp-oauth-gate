import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { setTestEnv } from '../helpers/testEnv.js';

setTestEnv();

let beginAuthorization: typeof import('../../src/oauth.js').beginAuthorization;
let completeAuthorization: typeof import('../../src/oauth.js').completeAuthorization;
let exchangeCode: typeof import('../../src/oauth.js').exchangeCode;

beforeAll(async () => {
    ({ beginAuthorization, completeAuthorization, exchangeCode } = await import('../../src/oauth.js'));
});

function pkcePair() {
    const verifier = 'a'.repeat(43); // min-length RFC7636 verifier
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

describe('PKCE + authorization code exchange', () => {
    it('accepts a valid code_verifier matching the stored code_challenge', () => {
        const { verifier, challenge } = pkcePair();
        const authId = beginAuthorization({ clientId: 'c1', redirectUri: 'https://client.test/cb', state: 's1', codeChallenge: challenge });
        const completed = completeAuthorization(authId, 'user@example.com');
        expect(completed).toBeDefined();

        const result = exchangeCode(completed!.code, 'c1', 'https://client.test/cb', verifier);
        expect(result).toEqual({ ok: true, email: 'user@example.com', clientId: 'c1' });
    });

    it('rejects a code_verifier that does not hash to the stored challenge', () => {
        const { challenge } = pkcePair();
        const authId = beginAuthorization({ clientId: 'c1', redirectUri: 'https://client.test/cb', state: 's1', codeChallenge: challenge });
        const completed = completeAuthorization(authId, 'user@example.com');

        const result = exchangeCode(completed!.code, 'c1', 'https://client.test/cb', 'wrong-verifier-wrong-verifier-wrong-verifie');
        expect(result).toEqual({ ok: false, error: 'invalid_grant' });
    });

    it('rejects redemption against a mismatched client_id or redirect_uri', () => {
        const { verifier, challenge } = pkcePair();
        const authId = beginAuthorization({ clientId: 'c1', redirectUri: 'https://client.test/cb', state: 's1', codeChallenge: challenge });
        const completed = completeAuthorization(authId, 'user@example.com');

        expect(exchangeCode(completed!.code, 'other-client', 'https://client.test/cb', verifier)).toEqual({ ok: false, error: 'invalid_grant' });
    });

    it('is single-use — the same code cannot be exchanged twice', () => {
        const { verifier, challenge } = pkcePair();
        const authId = beginAuthorization({ clientId: 'c1', redirectUri: 'https://client.test/cb', state: 's1', codeChallenge: challenge });
        const completed = completeAuthorization(authId, 'user@example.com');

        expect(exchangeCode(completed!.code, 'c1', 'https://client.test/cb', verifier).ok).toBe(true);
        expect(exchangeCode(completed!.code, 'c1', 'https://client.test/cb', verifier)).toEqual({ ok: false, error: 'invalid_grant' });
    });

    it('completeAuthorization returns undefined for an unknown authId', () => {
        expect(completeAuthorization('does-not-exist', 'user@example.com')).toBeUndefined();
    });
});
