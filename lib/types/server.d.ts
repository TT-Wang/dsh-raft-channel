import { type ActivityQueue } from './activity.js';
export declare const WAKE_SCHEMA = "raft-channel-wake.v1";
export type FailureClass = 'no_session' | 'busy' | 'protocol_mismatch' | 'auth_revoked' | 'injection_failed';
/** What the runtime answered for one wake. */
export type WakeOutcome = {
    ok: true;
    runtimeSession: string;
} | {
    ok: false;
    status: number;
    failureClass: FailureClass;
    reason: string;
    retryAfterMs?: number;
};
export interface ChannelServerOptions {
    host: string;
    port: number;
    token: string;
    wake(): Promise<WakeOutcome>;
    activityQueue?: ActivityQueue;
    onError?(error: unknown): void;
}
export interface ChannelServer {
    /** The wake endpoint URL, `http://<host>:<port>/wake`. */
    readonly url: string;
    close(): Promise<void>;
}
/**
 * Validate a wake body. Tolerates a missing `schema` (the contract lets
 * endpoints skip it) but rejects any other schema, content-shaped fields and
 * structured values.
 * @throws when the body violates the content-free wake contract.
 */
export declare function validateWakeBody(value: unknown): void;
/**
 * Start the channel HTTP server.
 * @returns the bound wake URL and an idempotent close.
 */
export declare function startChannelServer(options: ChannelServerOptions): Promise<ChannelServer>;
