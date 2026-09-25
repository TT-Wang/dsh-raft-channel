/**
 * The localhost endpoint `raft agent bridge --wake-adapter wake-channel` talks
 * to: `POST /wake` (raft-channel-wake.v1, content-free) plus the activity
 * drain. Every request needs the per-process `x-raft-bridge-token`.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ACTIVITY_DRAIN_SCHEMA, validateActivityEvent } from './activity.js';
export const WAKE_SCHEMA = 'raft-channel-wake.v1';
/** Metadata fields the CLI sends; each must be a short safe scalar when present. */
const WAKE_FIELDS = ['schema', 'attemptId', 'eventId', 'messageId', 'agentId', 'profile', 'coreSessionId', 'adapterInstance', 'occurredAt'];
/** Content-shaped fields: the transport is content-free by contract, so these are rejected loudly. */
const CONTENT_FIELDS = new Set([
    'text', 'content', 'contents', 'message', 'messages', 'body', 'preview', 'snippet', 'prompt', 'title', 'summary',
    'markdown', 'html', 'channel', 'channelName', 'channel_name', 'sender', 'senderName', 'sender_name', 'author',
]);
const SAFE_METADATA = /^[A-Za-z0-9._:@/+-]+$/;
const MAX_BODY_BYTES = 16 * 1024;
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
/**
 * Validate a wake body. Tolerates a missing `schema` (the contract lets
 * endpoints skip it) but rejects any other schema, content-shaped fields and
 * structured values.
 * @throws when the body violates the content-free wake contract.
 */
export function validateWakeBody(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('wake request must be a JSON object');
    const body = value;
    for (const [key, item] of Object.entries(body)) {
        if (CONTENT_FIELDS.has(key))
            throw new Error(`content-shaped field ${key} rejected: the wake transport is content-free`);
        if (item !== null && typeof item === 'object')
            throw new Error(`wake request field ${key} must be a scalar`);
    }
    if (body.schema !== undefined && body.schema !== WAKE_SCHEMA)
        throw new Error(`unsupported wake schema; expected ${WAKE_SCHEMA}`);
    for (const key of WAKE_FIELDS) {
        const item = body[key];
        if (item === undefined)
            continue;
        if (typeof item !== 'string' || item.length === 0 || item.length > 200 || !SAFE_METADATA.test(item)) {
            throw new Error(`wake request ${key} must be a short metadata string`);
        }
    }
}
function tokenMatches(header, token) {
    if (typeof header !== 'string')
        return false;
    const given = Buffer.from(header);
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, 'request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
async function readJson(req) {
    const text = await readBody(req);
    try {
        return JSON.parse(text);
    }
    catch {
        throw new HttpError(400, 'request body is not JSON');
    }
}
function send(res, status, value) {
    if (res.headersSent)
        return;
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}
function hostForUrl(host) {
    return host.includes(':') ? `[${host}]` : host;
}
/**
 * Start the channel HTTP server.
 * @returns the bound wake URL and an idempotent close.
 */
export async function startChannelServer(options) {
    const handle = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const authorized = tokenMatches(req.headers['x-raft-bridge-token'], options.token);
        const activity = options.activityQueue;
        if (url.pathname === '/wake') {
            if (req.method !== 'POST') {
                send(res, 405, { ok: false, failureClass: 'protocol_mismatch', reason: 'POST only' });
                return;
            }
            if (!authorized) {
                send(res, 401, { ok: false, failureClass: 'auth_revoked', reason: 'invalid Raft bridge token' });
                return;
            }
            try {
                validateWakeBody(await readJson(req));
            }
            catch (error) {
                const status = error instanceof HttpError ? error.status : 400;
                send(res, status, { ok: false, failureClass: 'protocol_mismatch', reason: error instanceof Error ? error.message : 'invalid wake request' });
                return;
            }
            const outcome = await options.wake();
            if (outcome.ok)
                send(res, 200, { ok: true, runtimeSession: outcome.runtimeSession });
            else {
                send(res, outcome.status, {
                    ok: false,
                    failureClass: outcome.failureClass,
                    reason: outcome.reason,
                    ...outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs },
                });
            }
            return;
        }
        if (url.pathname === '/activity/drain' && req.method === 'GET') {
            if (!authorized) {
                send(res, 401, { ok: false, error: 'invalid Raft bridge token' });
                return;
            }
            // With activity off the drain stays valid and empty, so the bridge logs
            // "no_events" instead of a failed drain on every iteration.
            const max = Number(url.searchParams.get('max') ?? '50');
            send(res, 200, activity === undefined ? { schema: ACTIVITY_DRAIN_SCHEMA, events: [], dropped: 0 } : activity.drain(max));
            return;
        }
        if (activity !== undefined && url.pathname === '/activity' && req.method === 'POST') {
            if (!authorized) {
                send(res, 401, { ok: false, error: 'invalid Raft bridge token' });
                return;
            }
            try {
                activity.push(validateActivityEvent(await readJson(req)));
            }
            catch (error) {
                const status = error instanceof HttpError ? error.status : 400;
                send(res, status, { ok: false, error: error instanceof Error ? error.message : 'invalid activity event' });
                return;
            }
            send(res, 202, { ok: true });
            return;
        }
        send(res, 404, { ok: false, failureClass: 'no_session', reason: 'unknown Raft channel endpoint' });
    };
    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            options.onError?.(error);
            send(res, 500, { ok: false, failureClass: 'injection_failed', reason: error instanceof Error ? error.message : 'internal error' });
        });
    });
    server.on('clientError', (_error, socket) => { socket.destroy(); });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    server.on('error', error => { options.onError?.(error); });
    const port = server.address().port;
    let closing;
    return {
        url: `http://${hostForUrl(options.host)}:${port}/wake`,
        close() {
            closing ??= new Promise(resolve => {
                server.close(() => { resolve(); });
                server.closeAllConnections();
            });
            return closing;
        },
    };
}
