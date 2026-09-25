import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ActivityRecorder, sessionLifecycleEvent } from './activity.js';
import { readState, STATE_SCHEMA, writeState } from './state.js';
import { ORIENTATION_SECTION, WAKE_NOTICE, orientationText } from './text.js';
/** Placement of the orientation: after the deployment persona body, before its suffix (10200). */
export const ORIENTATION_ORDER = 10_100;
/** How far `createFrom` probes past occupied ids before giving up. */
const MAX_ID_PROBES = 1000;
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function errorName(error) {
    return error instanceof Error ? error.name : undefined;
}
function isNotFound(error) {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
        if (cause.name === 'SessionPersistenceNotFoundError' || cause.name === 'SessionQueryError' && /not.found/i.test(cause.message))
            return true;
    }
    return false;
}
export class RaftRuntime {
    options;
    current;
    /** Rotated-out sessions still finishing their work; they keep reporting activity until disposed. */
    retiring = new Map();
    chain = Promise.resolve();
    pending;
    windowEnd = 0;
    tail = [];
    tailTimer;
    recoverTimer;
    recoverDelayMs = 1000;
    disposed = false;
    lastSessionId;
    injecting;
    constructor(options) {
        this.options = options;
    }
    /** The current session id, reported to the bridge as `runtimeSession`. */
    runtimeSession() {
        return this.current?.id ?? this.lastSessionId;
    }
    /** Turns completed in the current session (for status and tests). */
    currentTurns() {
        return this.current?.turns ?? 0;
    }
    /** The current live agent, when one is attached. */
    currentAgent() {
        return this.current?.handle.agent;
    }
    /** Run `task` after every earlier wake, rotation or recovery step settles. */
    serial(task) {
        const run = this.chain.then(task, task);
        this.chain = run.catch(() => undefined);
        return run;
    }
    /** Resume the session named by the state file, or create the first one. */
    async start() {
        await this.serial(async () => {
            const { config, logger } = this.options;
            const persistent = this.options.ctx.get('sessionPersistence') !== undefined;
            if (!persistent) {
                logger.warn('raft-channel: no sessionPersistence service is mounted; the Raft session lives in memory and is lost at exit');
            }
            let state;
            try {
                state = await readState(config.stateFile);
            }
            catch (error) {
                logger.error(`raft-channel: ${errorText(error)}; starting a new session series`);
            }
            if (state !== undefined && state.sessionPrefix !== config.sessionPrefix) {
                logger.warn(`raft-channel: sessionPrefix changed (${state.sessionPrefix} -> ${config.sessionPrefix}); starting a new session series, ${state.sessionId} stays resumable`);
                state = undefined;
            }
            let live;
            if (state !== undefined && persistent) {
                try {
                    live = await this.resume(state.sessionId, state.index);
                    logger.info(`raft-channel: resumed ${live.id} (${live.turns} turns)`);
                }
                catch (error) {
                    if (errorName(error) === 'SessionAlreadyOwnedError') {
                        throw new Error(`session ${state.sessionId} is already owned by a live writer; is another DSH process running Raft profile ${config.profile}?`);
                    }
                    if (isNotFound(error)) {
                        // Created but never written to (no turn ran before the restart): reuse the id.
                        logger.info(`raft-channel: ${state.sessionId} was never persisted; creating it now`);
                        live = await this.createFrom(state.index, state.previousSessionId);
                    }
                    else {
                        logger.error(`raft-channel: cannot resume ${state.sessionId} (${errorText(error)}); continuing in a new session`);
                        live = await this.createFrom(state.index + 1, state.sessionId);
                    }
                }
            }
            else {
                live = await this.createFrom(state === undefined ? 1 : state.index + 1, state?.sessionId);
            }
            if (this.disposed) {
                await live.handle.dispose().catch(() => undefined);
                return;
            }
            this.attach(live);
        });
    }
    attach(live) {
        this.current = live;
        this.lastSessionId = live.id;
    }
    currentSelection() {
        return this.options.ctx.agentDefaultModel.currentSelection();
    }
    setupFor(selection) {
        const text = orientationText(this.options.config.profile);
        return (agentCtx) => {
            installModelSelection(agentCtx, selection);
            agentCtx.systemPrompt.section({ name: ORIENTATION_SECTION, order: ORIENTATION_ORDER, text, interpolate: false });
        };
    }
    agentOptions(selection) {
        return {
            provider: selection.provider,
            model: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        };
    }
    liveSession(index, handle, selection, turns) {
        const { activity, secrets } = this.options;
        const id = handle.agent.session.id;
        const recorder = activity === undefined ? undefined : new ActivityRecorder(id, event => { activity.push(event); }, secrets);
        activity?.push(sessionLifecycleEvent('SessionStart', id));
        return { index, id, handle, turns, selection, recorder };
    }
    async resume(id, index) {
        const selected = this.currentSelection();
        const selection = { current: selected, assembled: undefined };
        const handle = await this.options.ctx.agents.resume({
            resumeSessionId: id,
            agentOptions: this.agentOptions(selected),
            setup: this.setupFor(selection),
        });
        return this.liveSession(index, handle, selection, countTurns(handle.agent.session));
    }
    /** Create `<prefix>-<n>` for the first free n ≥ start and point the state file at it. */
    async createFrom(start, previousSessionId) {
        const { config, ctx } = this.options;
        for (let index = start; index < start + MAX_ID_PROBES; index += 1) {
            const id = `${config.sessionPrefix}-${index}`;
            if (ctx.agents.get(id) !== undefined)
                continue;
            const selected = this.currentSelection();
            const selection = { current: selected, assembled: undefined };
            let handle;
            try {
                handle = await ctx.agents.create({
                    sessionId: id,
                    meta: { cwd: config.cwd },
                    agentOptions: this.agentOptions(selected),
                    setup: this.setupFor(selection),
                });
            }
            catch (error) {
                if (errorName(error) === 'SessionAlreadyExistsError' || /already exists/.test(errorText(error)))
                    continue;
                throw error;
            }
            try {
                await writeState(config.stateFile, {
                    schema: STATE_SCHEMA,
                    profile: config.profile,
                    sessionPrefix: config.sessionPrefix,
                    index,
                    sessionId: id,
                    ...previousSessionId === undefined ? {} : { previousSessionId },
                    updatedAt: new Date().toISOString(),
                });
            }
            catch (error) {
                // The session is usable; only the pointer is stale, so a restart would
                // resume the previous session. Say so instead of failing the wake path.
                this.options.logger.error(`raft-channel: could not write ${config.stateFile}: ${errorText(error)}`);
            }
            this.options.logger.info(`raft-channel: created session ${id}`);
            return this.liveSession(index, handle, selection, 0);
        }
        throw new Error(`no free session id in ${config.sessionPrefix}-${start}..${start + MAX_ID_PROBES - 1}`);
    }
    /** Answer one wake POST: 2xx only once a notice is in (or already covering) the inbox. */
    async wake() {
        if (this.disposed)
            return this.noSession('the Raft channel is shutting down');
        const decision = await this.serial(async () => this.decide());
        return 'wait' in decision ? decision.wait : decision.outcome;
    }
    noSession(reason) {
        return { ok: false, status: 503, failureClass: 'no_session', reason, retryAfterMs: 5000 };
    }
    decide() {
        const live = this.current;
        if (live === undefined || this.disposed)
            return { outcome: this.noSession('no Raft agent session is attached yet') };
        // An unclaimed notice is still ahead of the model, and its check will
        // drain whatever this wake announced.
        if (this.noticePending(live))
            return { outcome: { ok: true, runtimeSession: live.id } };
        if (this.options.config.debounceMs > 0 && Date.now() < this.windowEnd) {
            return { wait: new Promise(resolve => { this.tail.push(resolve); this.armTail(); }) };
        }
        return { outcome: this.injectOutcome(live) };
    }
    armTail() {
        if (this.tailTimer !== undefined)
            return;
        this.tailTimer = setTimeout(() => {
            this.tailTimer = undefined;
            this.serial(async () => { this.flushTail(); }).catch((error) => {
                this.options.logger.error(`raft-channel: wake flush failed: ${errorText(error)}`);
            });
        }, Math.max(0, this.windowEnd - Date.now()));
        this.tailTimer.unref();
    }
    /** Window close: one merged notice for every wake that arrived inside it. */
    flushTail() {
        const waiters = this.tail.splice(0);
        if (waiters.length === 0)
            return;
        const live = this.current;
        let outcome;
        if (live === undefined || this.disposed)
            outcome = this.noSession('no Raft agent session is attached');
        else if (this.noticePending(live))
            outcome = { ok: true, runtimeSession: live.id };
        else
            outcome = this.injectOutcome(live);
        for (const resolve of waiters)
            resolve(outcome);
    }
    noticePending(live) {
        const pending = this.pending;
        if (pending === undefined || pending.sessionId !== live.id)
            return false;
        return live.handle.agent.inbox.nextTurn.some(message => message.id === pending.messageId);
    }
    injectOutcome(live) {
        try {
            this.inject(live);
            this.windowEnd = Date.now() + this.options.config.debounceMs;
            return { ok: true, runtimeSession: live.id };
        }
        catch (error) {
            this.options.logger.error(`raft-channel: wake injection into ${live.id} failed: ${errorText(error)}`);
            return { ok: false, status: 500, failureClass: 'injection_failed', reason: `wake notice was not queued: ${errorText(error)}` };
        }
    }
    /**
     * Queue the fixed notice as a follow-up turn. Source kind 'user' is required:
     * the slice context policy only seals text-only user messages of that kind,
     * any other kind would stay raw in every later request.
     * @throws when the agent is gone or the inbox did not accept the message.
     */
    inject(live) {
        const agent = live.handle.agent;
        if (this.options.ctx.agents.get(live.id) !== agent)
            throw new Error(`agent ${live.id} is no longer live`);
        live.selection.current = this.currentSelection();
        const message = createUserMessage({ content: [{ type: 'text', text: WAKE_NOTICE }], source: { kind: 'user' } });
        // An idle driver claims the message synchronously inside followup(), so
        // "accepted" means still queued or already claimed by a turn.
        this.injecting = { id: message.id, claimed: false };
        try {
            agent.followup(message);
            const accepted = this.injecting.claimed || agent.inbox.nextTurn.some(queued => queued.id === message.id);
            if (!accepted)
                throw new Error('the follow-up did not enter the agent inbox');
        }
        finally {
            this.injecting = undefined;
        }
        this.pending = { sessionId: live.id, messageId: message.id };
    }
    /** `agent/inbox/claimed` feed: marks a notice claimed during its own followup(). */
    onClaimed(messageId) {
        if (this.injecting?.id === messageId)
            this.injecting.claimed = true;
    }
    /**
     * Observe one appended session event of any session; ours feed activity and,
     * for the current session, turn counting and rotation.
     */
    onSessionEvent(session, event) {
        const live = this.current?.id === session.id ? this.current : this.retiring.get(session.id);
        if (live === undefined)
            return;
        live.recorder?.record(event);
        if (event.type !== 'turn/end' || live !== this.current || this.disposed)
            return;
        live.turns += 1;
        this.serial(async () => { await this.maybeRotate(live); }).catch((error) => {
            this.options.logger.error(`raft-channel: rotation of ${live.id} failed: ${errorText(error)}; staying on it`);
        });
    }
    historyChars(live) {
        return JSON.stringify(live.handle.agent.session.deriveMessages()).length;
    }
    async maybeRotate(live) {
        if (live !== this.current || this.disposed)
            return;
        const { maxTurns, maxHistoryChars } = this.options.config.rotate;
        const turnsOver = live.turns >= maxTurns;
        const chars = turnsOver ? 0 : this.historyChars(live);
        if (!turnsOver && chars < maxHistoryChars)
            return;
        const next = await this.createFrom(live.index + 1, live.id);
        if (this.disposed) {
            await next.handle.dispose().catch(() => undefined);
            return;
        }
        this.attach(next);
        // A notice still waiting in the old inbox moves with the rotation; one
        // already claimed is handled there, so nothing is lost either way.
        const pending = this.pending;
        let carried = false;
        if (pending !== undefined && pending.sessionId === live.id) {
            carried = live.handle.agent.inbox.remove(pending.messageId);
            this.pending = undefined;
        }
        if (carried) {
            try {
                this.inject(next);
            }
            catch (error) {
                this.options.logger.error(`raft-channel: could not move the pending wake notice to ${next.id}: ${errorText(error)}; the bridge's reconciliation will re-wake`);
            }
        }
        this.options.logger.info(`raft-channel: rotated ${live.id} -> ${next.id} (${live.turns} turns${turnsOver ? '' : `, ${chars} history chars`})`);
        this.retire(live);
    }
    retire(live) {
        this.retiring.set(live.id, live);
        const done = () => { this.retiring.delete(live.id); };
        live.handle.agent.whenIdle()
            .then(() => live.handle.dispose())
            .then(done, (error) => {
            done();
            this.options.logger.warn(`raft-channel: retiring ${live.id} failed: ${errorText(error)}`);
        });
    }
    /**
     * The current agent left the registry without our asking (for example the
     * agent-loop plugin reloaded): re-attach its session with backoff.
     */
    onAgentDisposed(agent) {
        const live = this.current;
        if (this.disposed || live === undefined || live.handle.agent !== agent)
            return;
        this.options.logger.warn(`raft-channel: agent ${live.id} was disposed externally; re-attaching`);
        this.current = undefined;
        this.pending = undefined;
        this.scheduleRecover(live);
    }
    scheduleRecover(lost) {
        if (this.recoverTimer !== undefined || this.disposed)
            return;
        const delay = this.recoverDelayMs;
        this.recoverTimer = setTimeout(() => {
            this.recoverTimer = undefined;
            this.serial(async () => {
                if (this.disposed || this.current !== undefined)
                    return;
                const persistent = this.options.ctx.get('sessionPersistence') !== undefined;
                const live = persistent ? await this.resume(lost.id, lost.index) : await this.createFrom(lost.index + 1, lost.id);
                if (this.disposed) {
                    await live.handle.dispose().catch(() => undefined);
                    return;
                }
                this.attach(live);
                this.recoverDelayMs = 1000;
                this.options.logger.info(`raft-channel: re-attached ${live.id}`);
            }).catch((error) => {
                this.recoverDelayMs = Math.min(this.recoverDelayMs * 2, 60_000);
                this.options.logger.error(`raft-channel: re-attaching ${lost.id} failed: ${errorText(error)}; retrying in ${this.recoverDelayMs}ms`);
                this.scheduleRecover(lost);
            });
        }, delay);
        this.recoverTimer.unref();
    }
    /** Stop answering wakes and dispose every agent this runtime owns. */
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.tailTimer !== undefined)
            clearTimeout(this.tailTimer);
        if (this.recoverTimer !== undefined)
            clearTimeout(this.recoverTimer);
        this.tailTimer = undefined;
        this.recoverTimer = undefined;
        const waiters = this.tail.splice(0);
        for (const resolve of waiters)
            resolve(this.noSession('the Raft channel is shutting down'));
        await this.chain;
        const lives = [...this.current === undefined ? [] : [this.current], ...this.retiring.values()];
        this.current = undefined;
        this.retiring.clear();
        for (const live of lives) {
            this.options.activity?.push(sessionLifecycleEvent('SessionEnd', live.id));
            await live.handle.dispose().catch((error) => {
                this.options.logger.warn(`raft-channel: disposing ${live.id} failed: ${errorText(error)}`);
            });
        }
    }
}
/** Completed turns recorded in a session's log (read once, at resume). */
function countTurns(session) {
    let turns = 0;
    for (const event of session.snapshotEvents())
        if (event.type === 'turn/end')
            turns += 1;
    return turns;
}
