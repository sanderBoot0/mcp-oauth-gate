import { listTokens, revokeTokenAndFamily } from '../db.js';

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'list') {
    const rows = listTokens();
    if (rows.length === 0) {
        console.log('No tokens issued yet.');
    }
    for (const row of rows) {
        const expiry = row.expires_at ? `expires ${row.expires_at}` : 'never expires';
        console.log(
            `#${row.id}  ${row.revoked ? '[REVOKED] ' : ''}${row.device_name}  ${row.email}  created ${row.created_at}  last used ${row.last_used_at ?? 'never'}  ${expiry}`
        );
    }
} else if (cmd === 'revoke') {
    const id = Number(arg);
    if (!Number.isInteger(id)) {
        console.error('Usage: tokens revoke <id>');
        process.exit(1);
    }
    // Also kills the refresh-token chain that could otherwise silently mint
    // a replacement access token for an OAuth-issued device; a no-op for
    // device-code tokens, which don't have one.
    const ok = revokeTokenAndFamily(id);
    console.log(ok ? `Revoked token #${id}` : `No token with id ${id}`);
} else {
    console.log('Usage:\n  tokens list\n  tokens revoke <id>');
    process.exit(cmd ? 1 : 0);
}
