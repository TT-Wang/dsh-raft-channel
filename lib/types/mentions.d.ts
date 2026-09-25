import { type BridgeLogger } from './bridge.js';
import type { MentionRef } from './text.js';
export declare const MENTIONS_SCHEMA = "dsh-raft-channel-mentions.v1";
/** Ids the seen-set (and the checked short-id set) keeps, oldest evicted first. */
export declare const SEEN_CAP = 2000;
/** Per-CLI-call deadline. */
export declare const CLI_TIMEOUT_MS = 10000;
/** Pages (by `--offset`) one sweep reads per target: as many results as the seen-set holds. */
export declare const MAX_SEARCH_PAGES: number;
/**
 * Mentions younger than this are left for the next sweep: the wake hint and
 * `raft message check` usually deliver a mention within seconds, and a sweep
 * that reported it first would only cost a duplicate notice and turn.
 */
export declare const MENTION_GRACE_MS = 30000;
/** While the agent's own check work is pending, new mentions wait at most this long (from their send time) before a notice. */
export declare const MAX_DEFER_MS: number;
/** One `<result>` block of `raft message search` output. */
export interface SearchResult {
    id: string;
    /** The `Source:` line: `channel:<name>`, `thread:<parent>:<short>`, `dm:…`. */
    source: string;
    /** Display name (the server prefers it over the handle). */
    sender: string;
    senderType: string | undefined;
    /** Epoch ms, NaN when the line did not parse. */
    time: number;
    preview: string;
}
export interface Mention extends MentionRef {
    id: string;
    sender: string;
    time: number;
}
export interface SelfProfile {
    handle: string;
    displayName: string;
}
/**
 * Parse `raft message search` text output (CLI 0.0.26 `formatSearchResults`).
 * "No search results." and anything unrecognised parse to no results.
 */
export declare function parseSearchOutput(text: string): SearchResult[];
/** `2026-09-25 21:01:14 +08:00` (the CLI's local time with offset) → epoch ms, NaN otherwise. */
export declare function parseSearchTime(value: string): number;
/**
 * The reply target of a search `Source:`: `channel:<name>` → `#<name>`,
 * `thread:<parent>:<short>` → `#<parent>:<short>`. DM sources name the stored
 * DM channel, not the peer, so they give no usable target (undefined).
 */
export declare function sourceTarget(source: string): string | undefined;
/**
 * Whether a search preview contains an @mention of `handle`. The CLI renders
 * `@x` after whitespace as `user:x` (and wraps the hit in <match>); full-text
 * search also returns messages that merely contain the words, so this is the check.
 */
export declare function mentionsHandle(preview: string, handle: string): boolean;
/** `raft profile show --json` → the agent's handle and display name. */
export declare function parseProfile(text: string): SelfProfile;
/** Short ids of the messages a `raft message check` output delivered (`[target=… msg=<short> …]` headers). */
export declare function checkShortIds(text: string): string[];
export interface SweepOutcome {
    ok: boolean;
    /** Mentions a notice now names (0 when none were new or the notice failed). */
    notified: number;
    /** New mentions held back because the agent's own check may still deliver them. */
    deferred?: number;
    error?: string;
}
export interface SweeperOptions {
    command: string;
    profile: string;
    /** Seen-set and watermark file. */
    file: string;
    intervalMs: number;
    lookbackMs: number;
    targets: string[] | undefined;
    logger: BridgeLogger;
    /** Queue one notice naming these mentions; false (or a throw) retries them next sweep. */
    notify: (mentions: Mention[], handle: string) => Promise<boolean>;
    /**
     * Why a `raft message check` of the agent may still deliver new mentions
     * (an unclaimed wake notice, a wake turn before its check, a check call in
     * flight), if it may: new mentions then wait for a later sweep.
     */
    busy?: () => string | undefined;
    /** Minimum mention age before a report (default {@link MENTION_GRACE_MS}). */
    graceMs?: number;
    /** Search pages read per target and sweep (default {@link MAX_SEARCH_PAGES}). */
    maxPages?: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    /** Wall clock (ms) compared against server message times. */
    now?: () => number;
}
export declare class MentionSweeper {
    private readonly options;
    private readonly seen;
    private readonly checked;
    private watermark;
    private self;
    private readonly startedAt;
    private readonly loaded;
    private running;
    private timer;
    private saving;
    private stopped;
    private readonly children;
    /** Notified mentions whose notice this process queued and no turn has claimed yet. */
    private readonly unclaimed;
    /** Unclaimed mentions a previous process left in the file: its notice is gone, so queue them again. */
    private readonly orphans;
    private started;
    private runs;
    private lastError;
    constructor(options: SweeperOptions);
    private now;
    /**
     * Sweep once now, then every `intervalMs` after each sweep finishes. A sweep
     * already running (an early {@link sweep} call) is awaited first, then this
     * one runs, so the startup sweep always sees the attached session.
     */
    start(): void;
    private schedule;
    status(): {
        runs: number;
        seen: number;
        unclaimed: number;
        scheduled: boolean;
        lastError?: string;
    };
    /** Run one sweep; while one is running, its outcome (never two at once). */
    sweep(): Promise<SweepOutcome>;
    /** Record short ids a `raft message check` returned, so the sweep does not report them again. */
    markChecked(shortIds: readonly string[]): void;
    /**
     * A turn claimed the notice naming these mentions: they no longer need
     * queuing again after a restart. Recorded even after {@link stop}, since a
     * claim can land while the plugin shuts down.
     */
    markClaimed(mentions: readonly MentionRef[]): void;
    private run;
    /** Run the raft CLI read-only with the profile's environment; stdout on exit 0. */
    private cli;
    private load;
    /** Queue an atomic write of the current state after any earlier one. */
    private persist;
    /** Stop the timer, kill a running CLI call and wait for the last write. */
    stop(): Promise<void>;
}
