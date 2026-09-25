/**
 * Supervises the long-lived `raft agent bridge` child: spawn plan, argv/env,
 * NDJSON → logger, exponential restart backoff, and a terminal stop for
 * failures a restart cannot heal (fatal, revoked auth, identity mismatch).
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
/**
 * CLI error codes no restart can fix: configuration and identity. Anything
 * else (BRIDGE_ALREADY_RUNNING from a dying predecessor, crashes, signals, and
 * `bridge_fatal` for transient server refusals such as HTTP 429) restarts with
 * backoff. The CLI emits `bridge_fatal` for every non-SERVER_5XX CliError, so
 * that event alone is not a reason to stop.
 */
export const TERMINAL_ERROR_CODES = new Set([
    'BRIDGE_EXPECTED_AGENT_REQUIRED',
    'BRIDGE_IDENTITY_MISMATCH',
    'BRIDGE_REQUIRES_PROFILE',
    'PROFILE_ENV_CONFLICT',
    'PROFILE_FILE_UNREADABLE',
    'PROFILE_FILE_INVALID',
    'PROFILE_MANAGED_CONTEXT_CONFLICT',
    'MISSING_AGENT_ID',
    'MISSING_SERVER_URL',
    'MISSING_TOKEN',
    'INVALID_AGENT_TOKEN',
    'INVALID_ARG',
]);
const AUTH_PATTERN = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|revoked|INVALID_AGENT_TOKEN/i;
/**
 * Build the bridge argv. The token never appears here (argv is visible to
 * every local user through `ps`); it travels in RAFT_CHANNEL_TOKEN.
 */
export function buildBridgeArgs(options, runtimeSession) {
    return [
        'agent', 'bridge', '--json',
        '--wake-adapter', 'wake-channel',
        '--wake-channel-endpoint', options.endpoint,
        '--runtime-session', runtimeSession,
        '--expected-agent', options.expectedAgentId,
        ...options.pollIntervalMs === undefined ? [] : ['--poll-interval-ms', String(options.pollIntervalMs)],
    ];
}
/**
 * Child environment: both profile names with the same value (a newer CLI reads
 * RAFT_PROFILE, an older one SLOCK_PROFILE; equal values never conflict), the
 * wake token and the expected Agent id.
 */
export function buildBridgeEnv(options, base = process.env) {
    return {
        ...base,
        RAFT_PROFILE: options.profile,
        SLOCK_PROFILE: options.profile,
        RAFT_CHANNEL_TOKEN: options.token,
        RAFT_EXPECTED_AGENT_ID: options.expectedAgentId,
    };
}
/**
 * npm installs the CLI as `raft.cmd` on Windows, which spawn() cannot resolve
 * without a shell; shell + argv array is DEP0190, so win32 gets one fully
 * quoted command string. Other platforms spawn argv directly.
 */
export function bridgeSpawnPlan(platform, command, args) {
    if (platform !== 'win32')
        return { command, args, shell: false };
    const quote = (token) => `"${token.replaceAll('"', '\\"')}"`;
    return { command: [command, ...args].map(quote).join(' '), args: [], shell: true };
}
export class BridgeSupervisor {
    options;
    child;
    restartTimer;
    spawnedAt = 0;
    consecutiveFastExits = 0;
    terminal;
    status = { state: 'idle', restartCount: 0 };
    stopping = false;
    lastError;
    constructor(options) {
        this.options = options;
    }
    getStatus() {
        return { ...this.status };
    }
    /** Spawn the child unless stopped, terminal, or already running. */
    start() {
        if (this.stopping || this.terminal !== undefined || this.child !== undefined)
            return;
        const { options } = this;
        const args = buildBridgeArgs(options, options.runtimeSession());
        const plan = bridgeSpawnPlan(options.platform ?? process.platform, options.command, args);
        this.lastError = undefined;
        this.status = { ...this.status, state: 'starting', reason: undefined, nextRestartDelayMs: undefined };
        let child;
        try {
            child = spawn(plan.command, plan.args, {
                env: buildBridgeEnv(options, options.env ?? process.env),
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: plan.shell,
                windowsHide: true,
            });
        }
        catch (error) {
            options.logger.error(`raft bridge spawn failed: ${error instanceof Error ? error.message : String(error)}`);
            this.scheduleRestart();
            return;
        }
        this.child = child;
        child.once('spawn', () => {
            this.spawnedAt = Date.now();
            this.status = { ...this.status, state: 'running', pid: child.pid };
            options.logger.info(`raft bridge started pid=${child.pid} profile=${options.profile}`);
        });
        child.once('error', error => {
            // spawn failure (ENOENT...): 'exit' may not follow, so settle here.
            options.logger.error(`raft bridge child error: ${error.message}`);
            if (this.child === child) {
                this.child = undefined;
                this.scheduleRestart();
            }
        });
        // 'close' (not 'exit'): stdio is drained, so a final "Code: ..." line has
        // been classified before deciding whether to restart.
        child.once('close', (code, signal) => {
            if (this.child !== child)
                return;
            this.child = undefined;
            this.status = { ...this.status, pid: undefined, lastExit: { code, signal } };
            if (this.stopping) {
                this.status.state = 'stopped';
                return;
            }
            if (this.terminal !== undefined) {
                this.status = { ...this.status, state: this.terminal.state, terminalCode: this.terminal.code, reason: this.terminal.reason };
                options.logger.error(`raft bridge stopped for good (${this.terminal.code}): ${this.terminal.reason}. Wakes will not arrive until the cause is fixed and DSH (or this plugin) restarts.`);
                return;
            }
            options.logger.warn(`raft bridge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
            this.scheduleRestart();
        });
        if (child.stdout !== null)
            this.readLines(child.stdout, line => { this.onStdout(line); });
        if (child.stderr !== null)
            this.readLines(child.stderr, line => { this.onStderr(line); });
    }
    readLines(stream, onLine) {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', line => {
            try {
                if (line.trim() !== '')
                    onLine(line);
            }
            catch (error) {
                this.options.logger.warn(`raft bridge output handling failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        rl.on('error', () => { });
    }
    onStdout(line) {
        const { logger } = this.options;
        let event;
        try {
            const parsed = JSON.parse(line);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('not an object');
            event = parsed;
        }
        catch {
            logger.info(`[raft bridge] ${line}`);
            return;
        }
        const type = typeof event.type === 'string' ? event.type : typeof event.kind === 'string' ? event.kind : 'event';
        if (type === 'bridge_fatal') {
            const code = typeof event.errorCode === 'string' ? event.errorCode : 'BRIDGE_FATAL';
            const message = typeof event.message === 'string' ? event.message : '';
            // Only identity/configuration codes and explicit auth refusals are
            // terminal; a transient 4xx (429, 408, a proxy's 404) or an unmatched
            // Error ends this child but the next one, after backoff, may succeed.
            const terminal = TERMINAL_ERROR_CODES.has(code) || AUTH_PATTERN.test(`${code} ${message}`);
            if (terminal)
                this.markTerminal(code, message);
            logger.error(`[raft bridge] bridge_fatal ${code}: ${message}${terminal ? '' : ' (restarting with backoff)'}`);
            return;
        }
        if (event.outcome === 'failed' || type === 'bridge_retry' || type === 'reconcile_failed' || type === 'bridge_stream_unavailable') {
            logger.warn(`[raft bridge] ${line}`);
            return;
        }
        if (type === 'bridge_process_started' || type === 'bridge_recovered') {
            logger.info(`[raft bridge] ${line}`);
            return;
        }
        logger.debug(`[raft bridge] ${line}`);
    }
    onStderr(line) {
        // The CLI reports a thrown CliError as "Error: <message>" then "Code: <CODE>".
        const trimmed = line.trim();
        if (trimmed.startsWith('Error: '))
            this.lastError = trimmed.slice(7, 307);
        const match = /^Code:\s*([A-Z0-9_]+)$/.exec(trimmed);
        if (match !== null && TERMINAL_ERROR_CODES.has(match[1]))
            this.markTerminal(match[1], this.lastError ?? trimmed);
        this.options.logger.warn(`[raft bridge stderr] ${line}`);
    }
    markTerminal(code, reason) {
        if (this.terminal !== undefined)
            return;
        const state = AUTH_PATTERN.test(`${code} ${reason}`) ? 'auth_revoked' : 'fatal';
        this.terminal = { state, code, reason: reason.slice(0, 300) };
    }
    scheduleRestart() {
        if (this.stopping || this.terminal !== undefined || this.restartTimer !== undefined)
            return;
        const [first, max] = this.options.restartBackoffMs;
        const alive = this.spawnedAt === 0 ? 0 : Date.now() - this.spawnedAt;
        this.consecutiveFastExits = alive >= (this.options.stableAfterMs ?? 60_000) ? 1 : this.consecutiveFastExits + 1;
        const delay = Math.min(first * 2 ** Math.min(this.consecutiveFastExits - 1, 30), max);
        this.spawnedAt = 0;
        this.status = { ...this.status, state: 'restarting', restartCount: this.status.restartCount + 1, nextRestartDelayMs: delay };
        this.options.logger.warn(`raft bridge restart #${this.status.restartCount} in ${delay}ms`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            this.start();
        }, delay);
        this.restartTimer.unref();
    }
    /**
     * After {@link stop}: run one `--once` bridge iteration (poll mode, no
     * stream) so activity queued at shutdown, such as SessionEnd, still reaches
     * the server. Skipped after a terminal failure; bounded by `timeoutMs`.
     * Wakes it replays meet a disposed runtime (503) and stay in its ledger.
     */
    async runOnce(timeoutMs = 5000) {
        if (this.terminal !== undefined || this.child !== undefined)
            return;
        const { options } = this;
        const args = [...buildBridgeArgs(options, options.runtimeSession()), '--once'];
        const plan = bridgeSpawnPlan(options.platform ?? process.platform, options.command, args);
        let child;
        try {
            child = spawn(plan.command, plan.args, {
                env: buildBridgeEnv(options, options.env ?? process.env),
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: plan.shell,
                windowsHide: true,
            });
        }
        catch (error) {
            options.logger.warn(`raft bridge final flush could not start: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (child.stdout !== null)
            this.readLines(child.stdout, line => { options.logger.debug(`[raft bridge flush] ${line}`); });
        if (child.stderr !== null)
            this.readLines(child.stderr, line => { options.logger.debug(`[raft bridge flush stderr] ${line}`); });
        await new Promise(resolve => {
            const timer = setTimeout(() => {
                options.logger.warn(`raft bridge final flush did not finish in ${timeoutMs}ms; killing it`);
                child.kill('SIGKILL');
                resolve();
            }, timeoutMs);
            timer.unref();
            child.once('error', error => {
                clearTimeout(timer);
                options.logger.warn(`raft bridge final flush failed: ${error.message}`);
                resolve();
            });
            child.once('exit', code => {
                clearTimeout(timer);
                if (code !== 0)
                    options.logger.warn(`raft bridge final flush exited code=${code ?? 'null'}`);
                resolve();
            });
        });
    }
    /** Kill the child (SIGTERM, then SIGKILL after `graceMs`) and cancel restarts. */
    async stop(graceMs = 2000) {
        this.stopping = true;
        if (this.restartTimer !== undefined) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        const child = this.child;
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
            this.child = undefined;
            this.status = { ...this.status, state: 'stopped', pid: undefined };
            return;
        }
        await new Promise(resolve => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, graceMs);
            timer.unref();
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            child.kill('SIGTERM');
        });
        this.child = undefined;
        this.status = { ...this.status, state: 'stopped', pid: undefined };
    }
}
