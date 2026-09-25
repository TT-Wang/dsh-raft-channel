/**
 * The runtime half of the wake contract: one persistent agent session per
 * profile (resumed across restarts, rotated past size thresholds) and the
 * wake → fixed-notice injection with coalescing.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Agent } from '@deepseek-ai/dsh-agent';
import { type MessageId } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { type ActivityQueue } from './activity.js';
import type { ResolvedConfig } from './config.js';
import type { BridgeLogger } from './bridge.js';
import type { WakeOutcome } from './server.js';
/** Placement of the orientation: after the deployment persona body, before its suffix (10200). */
export declare const ORIENTATION_ORDER = 10100;
export interface RuntimeOptions {
    ctx: Context;
    config: ResolvedConfig;
    logger: BridgeLogger;
    activity: ActivityQueue | undefined;
    /** Values redacted from activity content (the wake token). */
    secrets: () => readonly string[];
}
export declare class RaftRuntime {
    private readonly options;
    private current;
    /** Rotated-out sessions still finishing their work; they keep reporting activity until disposed. */
    private readonly retiring;
    private chain;
    private pending;
    private windowEnd;
    private tail;
    private tailTimer;
    private recoverTimer;
    private recoverDelayMs;
    private disposed;
    private lastSessionId;
    private injecting;
    constructor(options: RuntimeOptions);
    /** The current session id, reported to the bridge as `runtimeSession`. */
    runtimeSession(): string | undefined;
    /** Turns completed in the current session (for status and tests). */
    currentTurns(): number;
    /** The current live agent, when one is attached. */
    currentAgent(): Agent | undefined;
    /** Run `task` after every earlier wake, rotation or recovery step settles. */
    private serial;
    /** Resume the session named by the state file, or create the first one. */
    start(): Promise<void>;
    private attach;
    private currentSelection;
    private setupFor;
    private agentOptions;
    private liveSession;
    private resume;
    /** Create `<prefix>-<n>` for the first free n ≥ start and point the state file at it. */
    private createFrom;
    /** Answer one wake POST: 2xx only once a notice is in (or already covering) the inbox. */
    wake(): Promise<WakeOutcome>;
    private noSession;
    private decide;
    private armTail;
    /** Window close: one merged notice for every wake that arrived inside it. */
    private flushTail;
    private noticePending;
    private injectOutcome;
    /**
     * Queue the fixed notice as a follow-up turn. Source kind 'user' is required:
     * the slice context policy only seals text-only user messages of that kind,
     * any other kind would stay raw in every later request.
     * @throws when the agent is gone or the inbox did not accept the message.
     */
    private inject;
    /** `agent/inbox/claimed` feed: marks a notice claimed during its own followup(). */
    onClaimed(messageId: MessageId): void;
    /**
     * Observe one appended session event of any session; ours feed activity and,
     * for the current session, turn counting and rotation.
     */
    onSessionEvent(session: Session, event: SessionEvent): void;
    private historyChars;
    private maybeRotate;
    private retire;
    /**
     * The current agent left the registry without our asking (for example the
     * agent-loop plugin reloaded): re-attach its session with backoff.
     */
    onAgentDisposed(agent: Agent): void;
    private scheduleRecover;
    /** Stop answering wakes and dispose every agent this runtime owns. */
    dispose(): Promise<void>;
}
