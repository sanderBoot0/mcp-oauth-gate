import { AUTH_PATH_PREFIX } from './env.js';

// The reverse proxy strips AUTH_PATH_PREFIX before proxying to this
// service, so this service's own Express routes are prefix-free — but any
// link/form rendered into HTML is resolved by the BROWSER against the real
// public path space, and must carry the prefix back.
const p = (path: string) => `${AUTH_PATH_PREFIX}${path}`;

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1.5rem; color: #222; }
  .code { font-size: 1.8rem; font-weight: 600; letter-spacing: 0.1em; background: #f2f2f2; padding: 0.75rem 1rem; border-radius: 8px; text-align: center; margin: 1.5rem 0; }
  a.button { display: inline-block; background: #24292f; color: #fff; text-decoration: none; padding: 0.65rem 1.25rem; border-radius: 6px; font-weight: 500; }
  input[type=text] { font-size: 1.2rem; padding: 0.5rem; width: 100%; box-sizing: border-box; letter-spacing: 0.05em; text-transform: uppercase; }
  form { margin: 1.5rem 0; }
`;

function page(title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function deviceCodeForm(prefill: string, error?: string): string {
    return page(
        'mcp-oauth-gate — Approve device',
        `<h1>Approve a device</h1>
     ${error ? `<p style="color:#c00">${error}</p>` : ''}
     <p>Enter the code shown on your device to authorize it.</p>
     <form action="${p('/device')}" method="get">
       <input type="text" name="user_code" value="${prefill}" maxlength="9" autofocus required>
       <p><button type="submit" class="button" style="border:none;cursor:pointer">Continue</button></p>
     </form>`
    );
}

export function confirmPage(userCode: string, deviceHint: string): string {
    return page(
        'mcp-oauth-gate — Confirm',
        `<h1>Confirm device</h1>
     <div class="code">${userCode}</div>
     <p>Device: <strong>${deviceHint}</strong></p>
     <p>Signing in will grant this device access to the protected service.</p>
     <p><a class="button" href="${p('/device/authorize')}?user_code=${encodeURIComponent(userCode)}">Continue</a></p>`
    );
}

export function successPage(deviceHint: string): string {
    return page(
        'mcp-oauth-gate — Approved',
        `<h1>Device approved</h1>
     <p><strong>${deviceHint}</strong> is now authorized. You can close this tab and return to your device.</p>`
    );
}

export function errorPage(message: string): string {
    return page('mcp-oauth-gate — Error', `<h1>Something went wrong</h1><p>${message}</p>`);
}
