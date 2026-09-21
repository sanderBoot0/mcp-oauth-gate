import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Sets required env vars before any module that reads env.ts is imported. Must run before the first `await import(...)` in a test file. */
export function setTestEnv(overrides: Record<string, string> = {}): void {
    const dbDir = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-gate-test-'));
    Object.assign(process.env, {
        BASE_URL: 'https://auth.test',
        RESOURCE_URL: 'https://mcp.test/mcp',
        AUTH_PROVIDER: 'github',
        CLIENT_ID: 'test-client-id',
        CLIENT_SECRET: 'test-client-secret',
        ALLOWED_EMAILS: 'allowed@example.com',
        DB_PATH: path.join(dbDir, 'tokens.db'),
        PORT: '0',
        ...overrides
    });
}
