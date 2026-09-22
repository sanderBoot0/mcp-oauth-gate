import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { DB_PATH } from './env.js';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
  );
`);

/** Parses a possibly-undefined sqlite row against a schema — `schema.parse` alone rejects `undefined` even when the row is legitimately absent (no match). */
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T | undefined {
    return row === undefined ? undefined : schema.parse(row);
}

const TableColumnSchema = z.object({ name: z.string() });

// Migration: short-lived OAuth access tokens need an expiry; tokens minted
// by the device-code flow leave this NULL (never expires), unchanged.
const tokenColumns = z.array(TableColumnSchema).parse(db.prepare('PRAGMA table_info(tokens)').all());
if (!tokenColumns.some(c => c.name === 'expires_at')) {
    db.exec('ALTER TABLE tokens ADD COLUMN expires_at TEXT');
}

const TokenRowSchema = z.object({
    id: z.number(),
    token_hash: z.string(),
    device_name: z.string(),
    email: z.string(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    revoked: z.number(),
    expires_at: z.string().nullable()
});
export type TokenRow = z.infer<typeof TokenRowSchema>;

export function insertToken(tokenHash: string, deviceName: string, email: string, expiresAt?: string): number {
    const result = db
        .prepare('INSERT INTO tokens (token_hash, device_name, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(tokenHash, deviceName, email, new Date().toISOString(), expiresAt ?? null);
    return Number(result.lastInsertRowid);
}

export function findActiveTokenByHash(tokenHash: string): TokenRow | undefined {
    const row = parseRow(TokenRowSchema, db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND revoked = 0').get(tokenHash));
    if (!row) return undefined;
    // ISO-8601 UTC timestamps compare correctly as plain strings.
    if (row.expires_at && row.expires_at < new Date().toISOString()) return undefined;
    return row;
}

export function touchLastUsed(id: number): void {
    db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function listTokens(): TokenRow[] {
    return z.array(TokenRowSchema).parse(db.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all());
}

export function revokeToken(id: number): boolean {
    const result = db.prepare('UPDATE tokens SET revoked = 1 WHERE id = ?').run(id);
    return result.changes > 0;
}

// Refresh tokens for the OAuth 2.1 flow (device-code tokens have none —
// they're long-lived by design, see the /device/token comment in
// server.ts). Each row is one link in a rotation chain: `family_id` is
// shared across every rotation of the same login, so a reused (already
// -revoked) refresh token lets us kill the *whole* chain — OAuth 2.1's
// recommended response to a refresh token that looks like it leaked.
db.exec(`
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    family_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    email TEXT NOT NULL,
    access_token_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
`);

const RefreshTokenRowSchema = z.object({
    id: z.number(),
    token_hash: z.string(),
    family_id: z.string(),
    client_id: z.string(),
    email: z.string(),
    access_token_id: z.number(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    expires_at: z.string(),
    revoked_at: z.string().nullable()
});
export type RefreshTokenRow = z.infer<typeof RefreshTokenRowSchema>;

export function insertRefreshToken(
    tokenHash: string,
    familyId: string,
    clientId: string,
    email: string,
    accessTokenId: number,
    expiresAt: string
): number {
    const result = db
        .prepare(
            'INSERT INTO refresh_tokens (token_hash, family_id, client_id, email, access_token_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(tokenHash, familyId, clientId, email, accessTokenId, new Date().toISOString(), expiresAt);
    return Number(result.lastInsertRowid);
}

export function findRefreshTokenByHash(tokenHash: string): RefreshTokenRow | undefined {
    return parseRow(RefreshTokenRowSchema, db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash));
}

/** Marks a refresh token as spent — called the moment it's redeemed, whether or not rotation succeeds. */
export function consumeRefreshToken(id: number): void {
    const now = new Date().toISOString();
    db.prepare('UPDATE refresh_tokens SET revoked_at = ?, last_used_at = ? WHERE id = ?').run(now, now, id);
}

const AccessTokenIdRowSchema = z.object({ access_token_id: z.number() });

/** Revokes every refresh token in a rotation chain plus the access tokens they minted — used on reuse-of-a-spent-token detection or an explicit device revoke. */
export function revokeRefreshFamily(familyId: string): void {
    const now = new Date().toISOString();
    const rows = z
        .array(AccessTokenIdRowSchema)
        .parse(db.prepare('SELECT access_token_id FROM refresh_tokens WHERE family_id = ?').all(familyId));
    db.prepare('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?').run(now, familyId);
    for (const row of rows) {
        db.prepare('UPDATE tokens SET revoked = 1 WHERE id = ?').run(row.access_token_id);
    }
}

const FamilyIdRowSchema = z.object({ family_id: z.string() });

/** Revokes an access token and, if it was issued via OAuth, the refresh chain that can mint replacements for it. Used by the `tokens revoke` admin command. */
export function revokeTokenAndFamily(accessTokenId: number): boolean {
    const revoked = revokeToken(accessTokenId);
    const row = parseRow(
        FamilyIdRowSchema,
        db.prepare('SELECT family_id FROM refresh_tokens WHERE access_token_id = ?').get(accessTokenId)
    );
    if (row) revokeRefreshFamily(row.family_id);
    return revoked;
}

// OAuth 2.1 dynamically-registered clients (RFC7591). Persisted (unlike the
// in-memory authorization/code state in oauth.ts) since a client registers
// once and is expected to reuse the same client_id indefinitely.
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const OAuthClientRowSchema = z.object({
    client_id: z.string(),
    client_name: z.string(),
    redirect_uris: z.string(), // JSON-encoded string[]
    created_at: z.string()
});
export type OAuthClientRow = z.infer<typeof OAuthClientRowSchema>;

export function insertOAuthClient(clientId: string, clientName: string, redirectUris: string[]): void {
    db.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(
        clientId,
        clientName,
        JSON.stringify(redirectUris),
        new Date().toISOString()
    );
}

export function findOAuthClient(clientId: string): OAuthClientRow | undefined {
    return parseRow(OAuthClientRowSchema, db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId));
}
