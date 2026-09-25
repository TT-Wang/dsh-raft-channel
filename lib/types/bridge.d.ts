export interface BridgeLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
export interface BridgeOptions {
    command: string;
    profile: string;
    expectedAgentId: string;
    /** Wake endpoint URL; the CLI derives `/activity/drain` from it. */
    endpoint: string;
    token: string;
    /** Current runtime session, read at every spawn. */
    runtimeSession: () => string;
    pollIntervalMs?: number;
    restartBackoffMs: [number, number];
    /** A child that stayed up this long resets the backoff (default 60s). */
    stableAfterMs?: number;
    logger: BridgeLogger;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}
export type BridgeState = 'idle' | 'starting' | 'running' | 'restarting' | 'stopped' | 'fatal' | 'auth_revoked';
export interface BridgeStatus {
    state: BridgeState;
    pid?: number;
    restartCount: number;
    nextRestartDelayMs?: number;
    lastExit?: {
        code: number | null;
        signal: NodeJS.Signals | null;
    };
    /** Error code of the terminal failure that stopped restarts. */
    terminalCode?: string;
    reason?: string;
}
/**
 * CLI error codes no restart can fix: configuration and identity. Anything
 * else (BRIDGE_ALREADY_RUNNING from a dying predecessor, crashes, signals, and
 * `bridge_fatal` for transient server refusals such as HTTP 429) restarts with
 * backoff. The CLI emits `bridge_fatal` for every non-SERVER_5XX CliError, so
 * that event alone is not a reason to stop.
 */
export declare const TERMINAL_ERROR_CODES: Set<string>;
/**
 * Build the bridge argv. The token never appears here (argv is visible to
 * every local user through `ps`); it travels in RAFT_CHANNEL_TOKEN.
 */
export declare function buildBridgeArgs(options: Pick<BridgeOptions, 'endpoint' | 'expectedAgentId' | 'pollIntervalMs'>, runtimeSession: string): string[];
/**
 * Child environment: both profile names with the same value (a newer CLI reads
 * RAFT_PROFILE, an older one SLOCK_PROFILE; equal values never conflict), the
 * wake token and the expected Agent id.
 */
export declare function buildBridgeEnv(options: Pick<BridgeOptions, 'profile' | 'token' | 'expectedAgentId'>, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * npm installs the CLI as `raft.cmd` on Windows, which spawn() cannot resolve
 * without a shell; shell + argv array is DEP0190, so win32 gets one fully
 * quoted command string. Other platforms spawn argv directly.
 */
export declare function bridgeSpawnPlan(platform: NodeJS.Platform, command: string, args: string[]): {
    command: string;
    args: string[];
    shell: boolean;
};
export declare class BridgeSupervisor {
    private readonly options;
    private child;
    private restartTimer;
    private spawnedAt;
    private consecutiveFastExits;
    private terminal;
    private status;
    private stopping;
    private lastError;
    constructor(options: BridgeOptions);
    getStatus(): BridgeStatus;
    /** Spawn the child unless stopped, terminal, or already running. */
    start(): void;
    private readLines;
    private onStdout;
    private onStderr;
    private markTerminal;
    private scheduleRestart;
    /**
     * After {@link stop}: run one `--once` bridge iteration (poll mode, no
     * stream) so activity queued at shutdown, such as SessionEnd, still reaches
     * the server. Skipped after a terminal failure; bounded by `timeoutMs`.
     * Wakes it replays meet a disposed runtime (503) and stay in its ledger.
     */
    runOnce(timeoutMs?: number): Promise<void>;
    /** Kill the child (SIGTERM, then SIGKILL after `graceMs`) and cancel restarts. */
    stop(graceMs?: number): Promise<void>;
}
