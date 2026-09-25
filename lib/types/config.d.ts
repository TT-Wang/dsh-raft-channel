export interface BridgeConfig {
    /** Spawn and supervise `raft agent bridge` (default true). */
    enabled?: boolean;
    /** Forwarded as `--poll-interval-ms`; omitted leaves the CLI default. */
    pollIntervalMs?: number;
    /** `[first, max]` restart delay in ms for an exited bridge child (default [1000, 60000]). */
    restartBackoffMs?: [number, number];
}
export interface ActivityConfig {
    /** Serve `GET /activity/drain` + `POST /activity` fed from DSH session events (default true). */
    enabled?: boolean;
    /** Bounded queue size; the oldest event is dropped and counted on overflow (default 500). */
    queueCap?: number;
}
export interface RotateConfig {
    /** Start the next session once a turn ends with at least this many turns in the current one (default 300). */
    maxTurns?: number;
    /** ...or once the serialized model-visible history reaches this many chars (default 1_500_000). */
    maxHistoryChars?: number;
}
export interface SweepConfig {
    /** Run the mention sweep (default true, whether or not the bridge runs). */
    enabled?: boolean;
    /** Time between sweeps in ms (default 60000, at least 15000). */
    intervalMs?: number;
    /** Only mentions newer than plugin start minus this many ms are considered (default 900000). */
    lookbackMs?: number;
    /** Channel targets (`#name` or `#name:thread`) to search; default every channel the agent can see. */
    targets?: string[];
}
export interface Config {
    /** Raft profile slug; defaults to `RAFT_PROFILE` (or the legacy `SLOCK_PROFILE`). */
    profile?: string;
    /** Agent id the bridge must resolve to; defaults to `RAFT_EXPECTED_AGENT_ID`. Required while the bridge is enabled. */
    expectedAgentId?: string;
    /** Raft CLI executable (default `raft`). */
    raftBin?: string;
    /** Session id prefix (default `raft-<profile>`); sessions are `<prefix>-<n>`. */
    sessionPrefix?: string;
    /** Agent workspace (default `<DSH_HOME>/raft-workspaces/<profile>`), created at startup. */
    cwd?: string;
    /** Wake endpoint bind address (default `127.0.0.1`). */
    host?: string;
    /** Wake endpoint port (default 0: ephemeral). */
    port?: number;
    /** Leading-edge wake debounce window in ms (default 1000; 0 disables the window). */
    debounceMs?: number;
    /**
     * Agent preset new sessions join, and resumed sessions that recorded none,
     * when the composition has the agent-preset registry (default: the
     * registry's current default). Ignored without the registry.
     */
    agentPreset?: string;
    bridge?: BridgeConfig;
    activity?: ActivityConfig;
    rotate?: RotateConfig;
    sweep?: SweepConfig;
}
export interface ResolvedConfig {
    profile: string;
    expectedAgentId: string | undefined;
    raftBin: string;
    sessionPrefix: string;
    cwd: string;
    host: string;
    port: number;
    debounceMs: number;
    /** Configured agent preset; undefined follows the registry default. */
    agentPreset: string | undefined;
    bridge: {
        enabled: boolean;
        pollIntervalMs: number | undefined;
        restartBackoffMs: [number, number];
    };
    activity: {
        enabled: boolean;
        queueCap: number;
    };
    rotate: {
        maxTurns: number;
        maxHistoryChars: number;
    };
    sweep: {
        enabled: boolean;
        intervalMs: number;
        lookbackMs: number;
        targets: string[] | undefined;
    };
    /** Where the current-session pointer lives: `<DSH_HOME>/raft-channel/<profile>.json`. */
    stateFile: string;
    /** True when `profile` came from config while the environment named none; the plugin exports it so the agent's `raft` calls agree. */
    exportProfile: boolean;
    /** Mention-sweep seen-set and watermark: `<DSH_HOME>/raft-channel/<profile>-mentions.json`. */
    mentionsFile: string;
}
export declare class RaftChannelConfigError extends Error {
    constructor(message: string);
}
/**
 * Resolve and validate the plugin configuration.
 * @param raw - the row's config as loaded.
 * @param env - process environment (RAFT_PROFILE, SLOCK_PROFILE, RAFT_EXPECTED_AGENT_ID).
 * @param dshHome - resolved Harness home.
 */
export declare function resolveConfig(raw: unknown, env: Record<string, string | undefined>, dshHome: string): ResolvedConfig;
/** Whether a bind host is loopback-only. */
export declare function isLoopbackHost(host: string): boolean;
