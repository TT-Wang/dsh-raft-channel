/**
 * raft-activity.v1: observational, at-most-once telemetry the bridge drains
 * and forwards. Fed from DSH session events (turn lifecycle, tool calls and
 * results). Assistant text and reasoning are never read; tool content is
 * capped at 4096 chars with explicit truncation flags and credential-shaped
 * values are redacted before capping.
 */
import { randomUUID } from 'node:crypto';
export const ACTIVITY_EVENT_SCHEMA = 'raft-activity.v1';
export const ACTIVITY_DRAIN_SCHEMA = 'raft-activity-drain.v1';
/** Uniform per-field content cap (the CLI's EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT). */
export const CONTENT_CAP = 4096;
/** Marker appended inside the cap, the same one the CLI uses. */
export const TRUNCATION_MARKER = '\n[truncated]';
/** Upper bound for one drain: the server rejects ingest batches above 200 events. */
export const MAX_DRAIN = 200;
/** Exactly the per-event keys the server's ingest accepts (camelCase side); anything else is rejected, not stripped. */
const ALLOWED_KEYS = new Set([
    'schema', 'eventId', 'sessionId', 'hookEventName', 'toolName', 'status', 'occurredAt', 'durationMs',
    'errorClass', 'toolInput', 'toolOutput', 'toolInputTruncated', 'toolOutputTruncated', 'truncated',
]);
const SCALAR_LIMITS = { eventId: 160, sessionId: 200, hookEventName: 80, toolName: 120, status: 40, errorClass: 120 };
const SAFE_SCALAR = /^[A-Za-z0-9._:@/ -]+$/;
/** Bounded queue; overflow drops the oldest event and counts it for the next drain. */
export class ActivityQueue {
    cap;
    events = [];
    droppedSinceDrain = 0;
    constructor(cap = 500) {
        this.cap = cap;
    }
    push(event) {
        this.events.push(event);
        while (this.events.length > this.cap) {
            this.events.shift();
            this.droppedSinceDrain += 1;
        }
    }
    /**
     * Remove and return up to `max` oldest events (at-most-once).
     * @param max - requested batch size; clamped to [1, 200].
     */
    drain(max = 50) {
        const take = Math.max(1, Math.min(Number.isFinite(max) ? Math.floor(max) : 50, MAX_DRAIN));
        const events = this.events.splice(0, take);
        const dropped = this.droppedSinceDrain;
        this.droppedSinceDrain = 0;
        return { schema: ACTIVITY_DRAIN_SCHEMA, events, dropped };
    }
    get size() {
        return this.events.length;
    }
}
/**
 * Redact credential-shaped substrings: known secrets verbatim, `key: value`
 * pairs whose key names a credential, bearer tokens and common token prefixes.
 * @param text - tool content.
 * @param secrets - exact values that must never leave the process.
 */
export function redactCredentials(text, secrets = []) {
    let result = text;
    for (const secret of secrets) {
        if (secret.length >= 8)
            result = result.split(secret).join('[REDACTED]');
    }
    return result
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]')
        .replace(/(\b(?:authorization|x-raft-bridge-token|[a-z_]*token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)\b["']?\s*[:=]\s*["']?)(?!Bearer\b|\[REDACTED\])([^\s"',;}]{6,})/gi, '$1[REDACTED]')
        .replace(/\b(?:sk|rk|pk|ghp|gho|ghs|github_pat|xox[abprs]|raft|slock|agt)[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED]');
}
/**
 * Stringify, redact and cap one content field.
 * @returns the capped text and whether it was cut, or undefined for empty content.
 */
export function capContent(value, secrets = []) {
    if (value === undefined || value === null)
        return undefined;
    let text;
    if (typeof value === 'string')
        text = value;
    else {
        try {
            text = JSON.stringify(value) ?? '';
        }
        catch {
            return undefined;
        }
    }
    if (text.length === 0)
        return undefined;
    // Bound the redaction work on huge outputs; the cut is far past the cap.
    const cut = text.length > 2 * CONTENT_CAP;
    text = redactCredentials(cut ? text.slice(0, 2 * CONTENT_CAP) : text, secrets);
    if (!cut && text.length <= CONTENT_CAP)
        return { text, truncated: false };
    return { text: text.slice(0, CONTENT_CAP - TRUNCATION_MARKER.length) + TRUNCATION_MARKER, truncated: true };
}
function scalar(value, key) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    const limit = SCALAR_LIMITS[key] ?? 120;
    const clipped = value.slice(0, limit);
    return SAFE_SCALAR.test(clipped) ? clipped : clipped.replace(/[^A-Za-z0-9._:@/ -]/g, '_');
}
/**
 * Validate one POSTed event: unknown keys are rejected (never stripped), scalars
 * must be safe, content is re-capped.
 * @throws when the body is not an acceptable raft-activity.v1 event.
 */
export function validateActivityEvent(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('activity event must be an object');
    const raw = value;
    for (const key of Object.keys(raw)) {
        if (!ALLOWED_KEYS.has(key))
            throw new Error(`activity event field ${key} is not allowed`);
    }
    if (raw.schema !== ACTIVITY_EVENT_SCHEMA)
        throw new Error(`activity event schema must be ${ACTIVITY_EVENT_SCHEMA}`);
    for (const key of ['eventId', 'hookEventName', 'occurredAt']) {
        if (typeof raw[key] !== 'string' || raw[key].length === 0)
            throw new Error(`activity event ${key} must be a non-empty string`);
    }
    if (Number.isNaN(Date.parse(raw.occurredAt)))
        throw new Error('activity event occurredAt must be an ISO timestamp');
    for (const key of ['eventId', 'sessionId', 'hookEventName', 'toolName', 'status', 'errorClass']) {
        const item = raw[key];
        if (item === undefined)
            continue;
        if (typeof item !== 'string' || item.length > SCALAR_LIMITS[key] || !SAFE_SCALAR.test(item)) {
            throw new Error(`activity event ${key} must be a safe string of at most ${SCALAR_LIMITS[key]} chars`);
        }
    }
    if (raw.durationMs !== undefined && (typeof raw.durationMs !== 'number' || !Number.isSafeInteger(raw.durationMs) || raw.durationMs < 0)) {
        throw new Error('activity event durationMs must be a non-negative integer');
    }
    for (const key of ['truncated', 'toolInputTruncated', 'toolOutputTruncated']) {
        if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
            throw new Error(`activity event ${key} must be a boolean`);
    }
    const event = { ...raw };
    for (const [key, flag] of [['toolInput', 'toolInputTruncated'], ['toolOutput', 'toolOutputTruncated']]) {
        const content = raw[key];
        if (content === undefined)
            continue;
        if (typeof content !== 'string')
            throw new Error(`activity event ${key} must be a string`);
        const capped = capContent(content);
        if (capped === undefined) {
            delete event[key];
            continue;
        }
        event[key] = capped.text;
        if (capped.truncated) {
            event[flag] = true;
            event.truncated = true;
        }
    }
    return event;
}
function base(hookEventName, sessionId, now) {
    return {
        schema: ACTIVITY_EVENT_SCHEMA,
        eventId: `event_${randomUUID()}`,
        sessionId: scalar(sessionId, 'sessionId') ?? 'unknown',
        hookEventName,
        occurredAt: now.toISOString(),
    };
}
/** Lifecycle event for session start (created or resumed) and end (plugin disposal). */
export function sessionLifecycleEvent(kind, sessionId, now = new Date()) {
    return { ...base(kind, sessionId, now), status: kind === 'SessionStart' ? 'started' : 'completed' };
}
/**
 * Maps one Session's events to activity. Holds the tool-call index needed to
 * name results and time them.
 */
export class ActivityRecorder {
    sessionId;
    emit;
    secrets;
    clock;
    calls = new Map();
    constructor(sessionId, emit, secrets = () => [], clock = () => new Date()) {
        this.sessionId = sessionId;
        this.emit = emit;
        this.secrets = secrets;
        this.clock = clock;
    }
    /**
     * Record one session event; everything except turn and tool boundaries is ignored.
     * @param event - an appended session event of this recorder's session.
     */
    record(event) {
        const now = this.clock();
        switch (event.type) {
            case 'turn/start': {
                this.emit({ ...base('UserPromptSubmit', this.sessionId, now), status: 'started' });
                return;
            }
            case 'turn/end': {
                const data = event.data;
                const reason = data.reason;
                const status = reason.kind === 'completed' ? 'completed' : reason.kind === 'error' ? 'failed' : reason.kind;
                const out = { ...base('Stop', this.sessionId, now), status: scalar(status, 'status') ?? 'completed' };
                if (reason.kind === 'error')
                    out.errorClass = scalar(reason.error.code, 'errorClass') ?? 'error';
                this.emit(out);
                this.calls.clear();
                return;
            }
            case 'tool/call': {
                const data = event.data;
                const toolName = scalar(data.name, 'toolName') ?? 'tool';
                this.calls.set(data.callId, { name: toolName, at: now.getTime() });
                const out = { ...base('PreToolUse', this.sessionId, now), toolName, status: 'started' };
                const input = capContent(data.arguments, this.secrets());
                if (input !== undefined) {
                    out.toolInput = input.text;
                    out.toolInputTruncated = input.truncated;
                    if (input.truncated)
                        out.truncated = true;
                }
                this.emit(out);
                return;
            }
            case 'tool/result': {
                const data = event.data;
                const call = this.calls.get(data.message.toolCallId);
                this.calls.delete(data.message.toolCallId);
                const failed = data.message.isError === true;
                const out = {
                    ...base(failed ? 'PostToolUseFailure' : 'PostToolUse', this.sessionId, now),
                    toolName: call?.name ?? 'tool',
                    status: failed ? 'failed' : 'succeeded',
                };
                if (call !== undefined)
                    out.durationMs = Math.max(0, now.getTime() - call.at);
                if (failed)
                    out.errorClass = scalar(data.error?.code, 'errorClass') ?? 'tool_failure';
                const text = data.message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n');
                const output = capContent(text, this.secrets());
                if (output !== undefined) {
                    out.toolOutput = output.text;
                    out.toolOutputTruncated = output.truncated;
                    if (output.truncated)
                        out.truncated = true;
                }
                this.emit(out);
                return;
            }
            default:
                return;
        }
    }
}
