import { beforeAll, describe, expect, it } from 'vitest';
import { setTestEnv } from '../helpers/testEnv.js';

setTestEnv();

let db: typeof import('../../src/db.js');

beforeAll(async () => {
    db = await import('../../src/db.js');
});

describe('token + refresh-token storage', () => {
    it('findActiveTokenByHash ignores revoked and expired tokens', () => {
        const hash = 'hash-active';
        const id = db.insertToken(hash, 'device-a', 'user@example.com');
        expect(db.findActiveTokenByHash(hash)?.id).toBe(id);

        db.revokeToken(id);
        expect(db.findActiveTokenByHash(hash)).toBeUndefined();

        const expiredHash = 'hash-expired';
        db.insertToken(expiredHash, 'device-b', 'user@example.com', new Date(Date.now() - 1000).toISOString());
        expect(db.findActiveTokenByHash(expiredHash)).toBeUndefined();
    });

    it('revokeRefreshFamily kills every token in the rotation chain (reuse-detection response)', () => {
        const family = 'family-1';
        const futureExpiry = new Date(Date.now() + 60_000).toISOString();

        const accessId1 = db.insertToken('rf-access-1', 'oauth:client', 'user@example.com', futureExpiry);
        db.insertRefreshToken('rf-hash-1', family, 'client-1', 'user@example.com', accessId1, futureExpiry);

        const accessId2 = db.insertToken('rf-access-2', 'oauth:client', 'user@example.com', futureExpiry);
        db.insertRefreshToken('rf-hash-2', family, 'client-1', 'user@example.com', accessId2, futureExpiry);

        expect(db.findActiveTokenByHash('rf-access-1')).toBeDefined();
        expect(db.findActiveTokenByHash('rf-access-2')).toBeDefined();

        db.revokeRefreshFamily(family);

        // Every access token minted anywhere in the chain is revoked, not just the reused one.
        expect(db.findActiveTokenByHash('rf-access-1')).toBeUndefined();
        expect(db.findActiveTokenByHash('rf-access-2')).toBeUndefined();
        expect(db.findRefreshTokenByHash('rf-hash-1')?.revoked_at).toBeTruthy();
        expect(db.findRefreshTokenByHash('rf-hash-2')?.revoked_at).toBeTruthy();
    });

    it('consumeRefreshToken marks a token spent without touching the rest of its family', () => {
        const family = 'family-2';
        const futureExpiry = new Date(Date.now() + 60_000).toISOString();
        const accessId = db.insertToken('cf-access-1', 'oauth:client', 'user@example.com', futureExpiry);
        const rowId = db.insertRefreshToken('cf-hash-1', family, 'client-1', 'user@example.com', accessId, futureExpiry);

        db.consumeRefreshToken(rowId);
        const row = db.findRefreshTokenByHash('cf-hash-1');
        expect(row?.revoked_at).toBeTruthy();
        // Consuming (a legitimate rotation) is not the same as reuse-detection revocation.
        expect(db.findActiveTokenByHash('cf-access-1')).toBeDefined();
    });
});

describe('oauth client registry (DCR)', () => {
    it('round-trips a registered client and its redirect_uris', () => {
        db.insertOAuthClient('client-abc', 'Test Client', ['https://client.test/cb', 'https://client.test/cb2']);
        const found = db.findOAuthClient('client-abc');
        expect(found?.client_name).toBe('Test Client');
        expect(JSON.parse(found!.redirect_uris)).toEqual(['https://client.test/cb', 'https://client.test/cb2']);
    });

    it('returns undefined for an unregistered client_id', () => {
        expect(db.findOAuthClient('never-registered')).toBeUndefined();
    });
});
