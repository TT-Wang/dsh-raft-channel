import type { Context } from '@deepseek-ai/cordis';
import { type Agent } from '@deepseek-ai/dsh-agent';
import { type MessageId } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { type ActivityQueue } from './activity.js';
import type { ResolvedConfig } from './config.js';
import type { BridgeLogger } from './bridge.js';
import type { WakeOutcome } from './server.js';
import { type MentionRef } from './text.js';
/** Placement of the orientation: after the deployment persona body, before its suffix (10200). */
export declare const ORIENTATION_ORDER = 10100;
/** Whether one shell command line runs `raft message check`. */
export declare function isRaftCheckCommand(command: string): boolean;
/**
 * Whether a `tool/call`'s raw arguments run `raft message check`: any
 * top-level string argument (`command`, `cmd`, `script`, … whatever the
 * shell tool names it) that matches, or the raw text when it is not a JSON
 * object. Tool names are not checked, for the same reason the pattern is loose.
 */
export declare function isRaftCheckCall(rawArguments: string): boolean;
/**
 * Whether a session log ends with acknowledged wake work that never ran to
 * completion: a turn still open (crash or dispose mid-turn), a turn closed as
 * interrupted, aborted or failed, or queued input canceled by a dispose. The
 * latest such fact wins; a completed turn after it already checked Raft.
 */
export declare function needsRewake(events: readonly SessionEvent[]): boolean;
export interface RuntimeOptions {
    ctx: Context;
    config: ResolvedConfig;
    logger: BridgeLogger;
    activity: ActivityQueue | undefined;
    /** Values redacted from activity content (the wake token). */
    secrets: () => readonly string[];
    /** Output of each `raft message check` tool call the agent ran (for the mention sweep). */
    onCheckOutput?: (text: string) => void;
    /** A turn claimed the mention notice naming these mentions (for the mention sweep). */
    onMentionsClaimed?: (mentions: readonly MentionRef[]) => void;
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
    /** The unclaimed mention notice, if any. */
    private pendingMention;
    /** A mention notice an external dispose canceled, re-queued on re-attach. */
    private orphanMention;
    /** `raft message check` tool calls awaiting their result, by session and call id. */
    private readonly checkCalls;
    /**
     * The running turn that one of our notices started, until it ends, and
     * whether it has started a `raft message check` call yet. While it has not,
     * that coming check drains whatever a new wake announces.
     */
    private noticeTurn;
    /** Wake counter for the per-wake debug log. */
    private wakes;
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
    /**
     * Queue one fresh notice on a session re-attached after a stop that may have
     * dropped an acknowledged wake (the bridge would otherwise wait for its
     * reconciliation, about two minutes). At-least-once: the check is idempotent.
     */
    private rewake;
    private attach;
    private currentSelection;
    private setupFor;
    private agentOptions;
    private liveSession;
    /**
     * List the session under its cwd in the workspace registry (web UI), when
     * the composition has one. Idempotent for an already attached session; a
     * failure only costs the listing.
     */
    private registerWorkspace;
    /**
     * Startup self-check: log the tools the agent's requests carry, and fail
     * loudly when none is a shell — the agent could not run `raft message
     * check`, and the bridge would re-wake it forever.
     */
    private checkTools;
    private resume;
    /** Create `<prefix>-<n>` for the first free n ≥ start and point the state file at it. */
    private createFrom;
    private createWith;
    /** Answer one wake POST: 2xx only once a notice is in (or already covering) the inbox. */
    wake(): Promise<WakeOutcome>;
    private noSession;
    private decide;
    /**
     * Why a wake needs no notice of its own, if it does not:
     * - an unclaimed notice is still ahead of the model, and its check will
     *   drain whatever this wake announced;
     * - a notice-started turn is running and has not started its
     *   `raft message check` yet: that check drains this wake's message too.
     *   The bridge's EAB-7 reconciliation re-POSTs a wake while its message is
     *   still pending server-side, which is exactly this window (between the
     *   notice starting a turn and the check draining the delivery); injecting
     *   there made a wasted turn that found "No new inbox messages".
     * Safety net: if the model never runs the check in that turn, the message
     * stays pending server-side and the bridge's next reconciliation wakes
     * again; by then the turn has ended and that wake is injected.
     */
    private coveredBy;
    /** Whether a notice-started turn of a session we still run has not started its check yet. */
    private preCheckTurn;
    private trace;
    private armTail;
    /** Window close: one merged notice for every wake that arrived inside it. */
    private flushTail;
    private noticePending;
    private injectOutcome;
    /**
     * Queue a notice as a follow-up turn, as a text-only user message with
     * source kind 'user' like a typed prompt. Context policies such as slice keep
     * such messages verbatim, so they never invalidate the cached prefix; rotation
     * bounds how many accumulate.
     * @throws when the agent is gone or the inbox did not accept the message.
     */
    private inject;
    /**
     * Queue one mention notice naming `mentions` (from the mention sweep). A
     * mention notice still unclaimed in the inbox is replaced by one naming its
     * mentions and these, so sweeps never stack notices. Wake coalescing does
     * not cover mentions: `raft message check` is exactly what may miss them.
     * @returns whether the notice is in (or already claimed from) the inbox.
     */
    mention(mentions: readonly MentionRef[], handle: string): Promise<boolean>;
    private injectMention;
    private mentionsClaimed;
    /**
     * Why a `raft message check` of the agent may still deliver messages that
     * reached Raft by now, if it may: a wake notice waits unclaimed, a
     * notice-started turn has not run its check yet, or a check call has not
     * returned. The mention sweep holds new mentions back meanwhile, so a
     * mention the normal path is about to deliver gets no second notice.
     */
    checkWork(): string | undefined;
    /**
     * `agent/inbox/claimed` feed: marks a notice claimed during its own
     * followup(), and notes the turn one of our notices starts. Notices are
     * queued as next-turn input, so they are claimed only at a turn's start.
     */
    onClaimed(sessionId: string, messageId: MessageId, turn: number): void;
    /**
     * Observe one appended session event of any session; ours feed activity and,
     * for the current session, turn counting and rotation.
     */
    onSessionEvent(session: Session, event: SessionEvent): void;
    /** Mark the notice-started turn checked at its first `raft message check` call; forget it when it ends. */
    private trackCheck;
    /** Hand each `raft message check` result's text to `onCheckOutput`. */
    private trackCheckOutput;
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
