import { randomBytes } from 'node:crypto';

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_SECONDS = 3;

type DeviceStatus = 'pending' | 'approved' | 'denied';

interface DeviceRequest {
    deviceCode: string;
    userCode: string;
    deviceNameHint: string;
    status: DeviceStatus;
    createdAt: number;
    expiresAt: number;
    rawToken?: string; // set once approved, cleared after first successful poll
    resolvedDeviceName?: string;
}

// Ephemeral, in-memory — losing this on restart just means an in-progress
// device pairing has to be retried. Long-lived tokens live in sqlite (db.ts),
// never in here.
const byDeviceCode = new Map<string, DeviceRequest>();
const byUserCode = new Map<string, string>(); // userCode -> deviceCode

function randomCode(bytes: number): string {
    return randomBytes(bytes).toString('hex');
}

function randomUserCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    const part = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    return `${part()}-${part()}`;
}

function isExpired(req: DeviceRequest): boolean {
    return Date.now() > req.expiresAt;
}

export function createDeviceRequest(deviceNameHint: string): {
    deviceCode: string;
    userCode: string;
    expiresIn: number;
    interval: number;
} {
    const deviceCode = randomCode(32);
    let userCode = randomUserCode();
    while (byUserCode.has(userCode)) userCode = randomUserCode();

    const now = Date.now();
    const req: DeviceRequest = {
        deviceCode,
        userCode,
        deviceNameHint: deviceNameHint.slice(0, 100) || 'unnamed-device',
        status: 'pending',
        createdAt: now,
        expiresAt: now + EXPIRY_MS
    };
    byDeviceCode.set(deviceCode, req);
    byUserCode.set(userCode, deviceCode);
    return { deviceCode, userCode, expiresIn: EXPIRY_MS / 1000, interval: POLL_INTERVAL_SECONDS };
}

export function findByUserCode(userCode: string): DeviceRequest | undefined {
    const deviceCode = byUserCode.get(userCode.toUpperCase());
    if (!deviceCode) return undefined;
    const req = byDeviceCode.get(deviceCode);
    if (!req || isExpired(req)) return undefined;
    return req;
}

export function approve(userCode: string, rawToken: string, resolvedDeviceName: string): boolean {
    const req = findByUserCode(userCode);
    if (!req) return false;
    req.status = 'approved';
    req.rawToken = rawToken;
    req.resolvedDeviceName = resolvedDeviceName;
    return true;
}

export type PollResult = { status: 'pending' } | { status: 'expired' } | { status: 'approved'; token: string; deviceName: string };

/** Consumes the token on first successful poll — it's handed to the client exactly once. */
export function pollAndConsume(deviceCode: string): PollResult {
    const req = byDeviceCode.get(deviceCode);
    if (!req || isExpired(req)) {
        if (req) {
            byDeviceCode.delete(req.deviceCode);
            byUserCode.delete(req.userCode);
        }
        return { status: 'expired' };
    }
    if (req.status !== 'approved' || !req.rawToken) {
        return { status: 'pending' };
    }
    const result: PollResult = { status: 'approved', token: req.rawToken, deviceName: req.resolvedDeviceName! };
    byDeviceCode.delete(req.deviceCode);
    byUserCode.delete(req.userCode);
    return result;
}

export function deviceNameHintFor(userCode: string): string | undefined {
    return findByUserCode(userCode)?.deviceNameHint;
}
