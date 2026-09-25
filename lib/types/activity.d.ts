import type { SessionEvent } from '@deepseek-ai/dsh-session';
export declare const ACTIVITY_EVENT_SCHEMA = "raft-activity.v1";
export declare const ACTIVITY_DRAIN_SCHEMA = "raft-activity-drain.v1";
/** Uniform per-field content cap (the CLI's EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT). */
export declare const CONTENT_CAP = 4096;
/** Marker appended inside the cap, the same one the CLI uses. */
export declare const TRUNCATION_MARKER = "\n[truncated]";
/** Upper bound for one drain: the server rejects ingest batches above 200 events. */
export declare const MAX_DRAIN = 200;
export interface ActivityEvent {
    schema: typeof ACTIVITY_EVENT_SCHEMA;
    eventId: string;
    sessionId?: string;
    hookEventName: string;
    toolName?: string;
    status?: string;
    occurredAt: string;
    durationMs?: number;
    errorClass?: string;
    toolInput?: string;
    toolOutput?: string;
    toolInputTruncated?: boolean;
    toolOutputTruncated?: boolean;
    truncated?: boolean;
}
export interface DrainResult {
    schema: typeof ACTIVITY_DRAIN_SCHEMA;
    events: ActivityEvent[];
    /** Events dropped to the queue cap since the previous drain. */
    dropped: number;
}
/** Bounded queue; overflow drops the oldest event and counts it for the next drain. */
export declare class ActivityQueue {
    private readonly cap;
    private events;
    private droppedSinceDrain;
    constructor(cap?: number);
    push(event: ActivityEvent): void;
    /**
     * Remove and return up to `max` oldest events (at-most-once).
     * @param max - requested batch size; clamped to [1, 200].
     */
    drain(max?: number): DrainResult;
    get size(): number;
}
/**
 * Redact credential-shaped substrings: known secrets verbatim, `key: value`
 * pairs whose key names a credential, bearer tokens and common token prefixes.
 * @param text - tool content.
 * @param secrets - exact values that must never leave the process.
 */
export declare function redactCredentials(text: string, secrets?: readonly string[]): string;
/**
 * Stringify, redact and cap one content field.
 * @returns the capped text and whether it was cut, or undefined for empty content.
 */
export declare function capContent(value: unknown, secrets?: readonly string[]): {
    text: string;
    truncated: boolean;
} | undefined;
/**
 * Validate one POSTed event: unknown keys are rejected (never stripped), scalars
 * must be safe, content is re-capped.
 * @throws when the body is not an acceptable raft-activity.v1 event.
 */
export declare function validateActivityEvent(value: unknown): ActivityEvent;
/** Lifecycle event for session start (created or resumed) and end (plugin disposal). */
export declare function sessionLifecycleEvent(kind: 'SessionStart' | 'SessionEnd', sessionId: string, now?: Date): ActivityEvent;
/**
 * Maps one Session's events to activity. Holds the tool-call index needed to
 * name results and time them.
 */
export declare class ActivityRecorder {
    private readonly sessionId;
    private readonly emit;
    private readonly secrets;
    private readonly clock;
    private readonly calls;
    constructor(sessionId: string, emit: (event: ActivityEvent) => void, secrets?: () => readonly string[], clock?: () => Date);
    /**
     * Record one session event; everything except turn and tool boundaries is ignored.
     * @param event - an appended session event of this recorder's session.
     */
    record(event: SessionEvent): void;
}
