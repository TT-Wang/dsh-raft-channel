/** Configuration: validated once at load, unknown keys rejected with the valid list. */
import { isAbsolute, join, resolve } from 'node:path';
const TOP_KEYS = ['profile', 'expectedAgentId', 'raftBin', 'sessionPrefix', 'cwd', 'host', 'port', 'debounceMs', 'agentPreset', 'bridge', 'activity', 'rotate'];
const BRIDGE_KEYS = ['enabled', 'pollIntervalMs', 'restartBackoffMs'];
const ACTIVITY_KEYS = ['enabled', 'queueCap'];
const ROTATE_KEYS = ['maxTurns', 'maxHistoryChars'];
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export class RaftChannelConfigError extends Error {
    constructor(message) {
        super(`raft-channel: ${message}`);
        this.name = 'RaftChannelConfigError';
    }
}
function checkKeys(value, valid, where) {
    if (value === undefined || value === null)
        return {};
    if (typeof value !== 'object' || Array.isArray(value))
        throw new RaftChannelConfigError(`${where} must be an object`);
    for (const key of Object.keys(value)) {
        if (!valid.includes(key))
            throw new RaftChannelConfigError(`unknown configuration key ${where === 'config' ? key : `${where}.${key}`}; valid keys: ${valid.join(', ')}`);
    }
    return value;
}
function int(value, fallback, name, min, max = Number.MAX_SAFE_INTEGER) {
    const result = value ?? fallback;
    if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < min || result > max) {
        throw new RaftChannelConfigError(`${name} must be an integer in [${min}, ${max}]`);
    }
    return result;
}
function bool(value, fallback, name) {
    const result = value ?? fallback;
    if (typeof result !== 'boolean')
        throw new RaftChannelConfigError(`${name} must be a boolean`);
    return result;
}
function str(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || value.trim() === '')
        throw new RaftChannelConfigError(`${name} must be a non-empty string`);
    return value.trim();
}
function envValue(env, key) {
    const value = env[key]?.trim();
    return value === undefined || value === '' ? undefined : value;
}
/**
 * Resolve and validate the plugin configuration.
 * @param raw - the row's config as loaded.
 * @param env - process environment (RAFT_PROFILE, SLOCK_PROFILE, RAFT_EXPECTED_AGENT_ID).
 * @param dshHome - resolved Harness home.
 */
export function resolveConfig(raw, env, dshHome) {
    const config = checkKeys(raw, TOP_KEYS, 'config');
    const bridge = checkKeys(config.bridge, BRIDGE_KEYS, 'bridge');
    const activity = checkKeys(config.activity, ACTIVITY_KEYS, 'activity');
    const rotate = checkKeys(config.rotate, ROTATE_KEYS, 'rotate');
    // Mirror the CLI: RAFT_PROFILE is canonical, SLOCK_PROFILE a deprecated alias;
    // both set and different is an error, never a silent pick.
    const raftProfile = envValue(env, 'RAFT_PROFILE');
    const slockProfile = envValue(env, 'SLOCK_PROFILE');
    if (raftProfile !== undefined && slockProfile !== undefined && raftProfile !== slockProfile) {
        throw new RaftChannelConfigError(`RAFT_PROFILE=${raftProfile} and SLOCK_PROFILE=${slockProfile} disagree; unset one (RAFT_PROFILE is canonical)`);
    }
    const envProfile = raftProfile ?? slockProfile;
    const configProfile = str(config.profile, 'profile');
    if (configProfile !== undefined && envProfile !== undefined && configProfile !== envProfile) {
        // The agent runs `raft` through its shell, which inherits the process
        // environment: a differing env profile would make it act as another identity.
        throw new RaftChannelConfigError(`profile ${configProfile} differs from the environment's RAFT_PROFILE=${envProfile}; the agent's raft CLI calls inherit the environment, so both must name the same profile`);
    }
    const profile = configProfile ?? envProfile;
    if (profile === undefined)
        throw new RaftChannelConfigError('no Raft profile: set RAFT_PROFILE (or config.profile)');
    if (!SLUG.test(profile))
        throw new RaftChannelConfigError(`profile ${JSON.stringify(profile)} is not a valid profile slug`);
    const bridgeEnabled = bool(bridge.enabled, true, 'bridge.enabled');
    const expectedAgentId = str(config.expectedAgentId, 'expectedAgentId') ?? envValue(env, 'RAFT_EXPECTED_AGENT_ID');
    if (bridgeEnabled && expectedAgentId === undefined) {
        // Never guessed from the credential file: the whole point of the CLI's
        // check is an independent statement of which Agent this runtime is for.
        throw new RaftChannelConfigError('the bridge needs an independently expected Agent id: set RAFT_EXPECTED_AGENT_ID (or config.expectedAgentId) to the Agent id from the Raft setup card, or set bridge.enabled: false');
    }
    if (expectedAgentId !== undefined && !AGENT_ID.test(expectedAgentId)) {
        throw new RaftChannelConfigError('expectedAgentId contains unsupported characters');
    }
    const sessionPrefix = str(config.sessionPrefix, 'sessionPrefix') ?? `raft-${profile}`;
    if (!SLUG.test(sessionPrefix))
        throw new RaftChannelConfigError('sessionPrefix must match [A-Za-z0-9._-] and start alphanumeric');
    const cwdRaw = str(config.cwd, 'cwd');
    const cwd = cwdRaw === undefined ? join(dshHome, 'raft-workspaces', profile) : resolve(cwdRaw);
    if (cwdRaw !== undefined && !isAbsolute(cwdRaw))
        throw new RaftChannelConfigError('cwd must be an absolute path');
    const backoff = bridge.restartBackoffMs ?? [1000, 60_000];
    if (!Array.isArray(backoff) || backoff.length !== 2)
        throw new RaftChannelConfigError('bridge.restartBackoffMs must be [firstMs, maxMs]');
    const first = int(backoff[0], 1000, 'bridge.restartBackoffMs[0]', 1);
    const max = int(backoff[1], 60_000, 'bridge.restartBackoffMs[1]', first);
    return {
        profile,
        expectedAgentId,
        raftBin: str(config.raftBin, 'raftBin') ?? 'raft',
        sessionPrefix,
        cwd,
        host: str(config.host, 'host') ?? '127.0.0.1',
        port: int(config.port, 0, 'port', 0, 65_535),
        debounceMs: int(config.debounceMs, 1000, 'debounceMs', 0, 60_000),
        agentPreset: str(config.agentPreset, 'agentPreset'),
        bridge: {
            enabled: bridgeEnabled,
            pollIntervalMs: bridge.pollIntervalMs === undefined ? undefined : int(bridge.pollIntervalMs, 0, 'bridge.pollIntervalMs', 1),
            restartBackoffMs: [first, max],
        },
        activity: {
            enabled: bool(activity.enabled, true, 'activity.enabled'),
            queueCap: int(activity.queueCap, 500, 'activity.queueCap', 1, 100_000),
        },
        rotate: {
            maxTurns: int(rotate.maxTurns, 300, 'rotate.maxTurns', 1),
            maxHistoryChars: int(rotate.maxHistoryChars, 1_500_000, 'rotate.maxHistoryChars', 1),
        },
        stateFile: join(dshHome, 'raft-channel', `${profile}.json`),
        exportProfile: envProfile === undefined,
    };
}
/** Whether a bind host is loopback-only. */
export function isLoopbackHost(host) {
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
