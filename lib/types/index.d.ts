import { Context, Service } from '@deepseek-ai/cordis';
import { type BridgeStatus } from './bridge.js';
import { type Config } from './config.js';
export type { Config, ResolvedConfig } from './config.js';
export { RaftChannelConfigError, resolveConfig } from './config.js';
export { WAKE_NOTICE, orientationText, ORIENTATION_SECTION } from './text.js';
export { ActivityQueue, ActivityRecorder, capContent, redactCredentials, validateActivityEvent, CONTENT_CAP } from './activity.js';
export type { ActivityEvent, DrainResult } from './activity.js';
export { BridgeSupervisor, buildBridgeArgs, buildBridgeEnv, bridgeSpawnPlan, TERMINAL_ERROR_CODES } from './bridge.js';
export type { BridgeLogger, BridgeOptions, BridgeStatus, BridgeState } from './bridge.js';
export { startChannelServer, validateWakeBody, WAKE_SCHEMA } from './server.js';
export type { WakeOutcome, FailureClass } from './server.js';
export { readState, writeState, STATE_SCHEMA } from './state.js';
export type { ChannelState } from './state.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        raftChannel: RaftChannel;
    }
}
export interface RaftChannelStatus {
    state: 'starting' | 'ready' | 'failed' | 'disposed';
    profile: string;
    /** Wake endpoint URL once listening. */
    endpoint?: string;
    /** Current session id (the `runtimeSession` every wake answer carries). */
    runtimeSession?: string;
    turns: number;
    bridge?: BridgeStatus;
    activityQueued?: number;
    error?: string;
}
export declare class RaftChannel extends Service {
    static inject: string[];
    private readonly settings;
    private readonly runtime;
    private readonly activity;
    private server;
    private bridge;
    private state;
    private failure;
    private readonly ready;
    constructor(ctx: Context, config?: Config);
    /** Resolves once startup finished (or failed; see {@link status}). */
    whenReady(): Promise<void>;
    status(): RaftChannelStatus;
}
export default RaftChannel;
