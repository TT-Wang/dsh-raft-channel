/**
 * The runtime half of the wake contract: one persistent agent session per
 * profile (resumed across restarts, rotated past size thresholds) and the
 * wake → fixed-notice injection with coalescing.
 */
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ActivityRecorder, sessionLifecycleEvent, type ActivityQueue } from './activity.js'
import type { ResolvedConfig } from './config.js'
import type { BridgeLogger } from './bridge.js'
import {
  acquirePreset,
  isAgentPresetError,
  mountPreset,
  presetRegistry,
  recordedPreset,
  resolvePreset,
  SHELL_TOOLS,
  visibleToolNames,
  workspaceRegistry,
} from './presets.js'
import type { WakeOutcome } from './server.js'
import { readState, STATE_SCHEMA, writeState } from './state.js'
import { ORIENTATION_SECTION, WAKE_NOTICE, orientationText } from './text.js'

/** Placement of the orientation: after the deployment persona body, before its suffix (10200). */
export const ORIENTATION_ORDER = 10_100
/** How far `createFrom` probes past occupied ids before giving up. */
const MAX_ID_PROBES = 1000
/** Turn endings after which the model may not have run `raft message check`. */
const UNFINISHED_TURN_ENDS = new Set(['interrupted', 'aborted', 'error'])

/** Monotonic milliseconds: the debounce window must not stretch when the wall clock jumps back. */
const monotonicNow = (): number => performance.now()

/**
 * `raft message check` (or the legacy `slock` alias) as one command of a shell
 * line: at the start, after a separator, quote, subshell paren or path slash,
 * with an optional profile option before `message`: `--profile <slug>`,
 * `--profile=<slug>`, or the CLI's short form `-p <slug>` / `-p<slug>`
 * (commander registers `-p, --profile <slug>` globally). Env prefixes such as
 * `RAFT_PROFILE=x raft message check` and pipes after it match.
 *
 * Deliberately loose: the words anywhere after whitespace match too, so
 * `echo raft message check` or a reply body that quotes the command counts
 * as a check. A false match only turns check-aware coalescing off for the
 * rest of that turn (the plugin injects as it would without it); a missed
 * match could hold back a wake that needed a notice.
 */
const RAFT_CHECK = /(^|[;&|(\s/"'`])(raft|slock)(\s+(--profile(=|\s+)|-p\s*)\S+)?\s+message\s+check\b/

/** Whether one shell command line runs `raft message check`. */
export function isRaftCheckCommand(command: string): boolean {
  return RAFT_CHECK.test(command)
}

/**
 * Whether a `tool/call`'s raw arguments run `raft message check`: any
 * top-level string argument (`command`, `cmd`, `script`, … whatever the
 * shell tool names it) that matches, or the raw text when it is not a JSON
 * object. Tool names are not checked, for the same reason the pattern is loose.
 */
export function isRaftCheckCall(rawArguments: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return isRaftCheckCommand(rawArguments)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return isRaftCheckCommand(rawArguments)
  return Object.values(parsed).some(value => typeof value === 'string' && isRaftCheckCommand(value))
}

/**
 * Whether a session log ends with acknowledged wake work that never ran to
 * completion: a turn still open (crash or dispose mid-turn), a turn closed as
 * interrupted, aborted or failed, or queued input canceled by a dispose. The
 * latest such fact wins; a completed turn after it already checked Raft.
 */
export function needsRewake(events: readonly SessionEvent[]): boolean {
  let unfinished = false
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = true
    } else if (event.type === 'turn/end') {
      open = false
      unfinished = UNFINISHED_TURN_ENDS.has((event as SessionEvent<'turn/end'>).data.reason.kind)
    } else if (event.type === 'agent/inbox/spliced') {
      const data = (event as SessionEvent<'agent/inbox/spliced'>).data
      if (data.outcome === 'canceled' && (data.removedCount ?? 0) > 0) unfinished = true
    }
  }
  return unfinished || open
}

interface LiveSession {
  index: number
  id: SessionId
  handle: AgentHandle
  turns: number
  selection: ModelSelectionRef
  recorder: ActivityRecorder | undefined
  /** Agent preset the agent joined; undefined in a composition without the preset registry. */
  preset: string | undefined
}

/** Composition step run in the setup callback before the model selection is installed. */
type Compose = (agentCtx: Context, agent: Agent) => Promise<void>

export interface RuntimeOptions {
  ctx: Context
  config: ResolvedConfig
  logger: BridgeLogger
  activity: ActivityQueue | undefined
  /** Values redacted from activity content (the wake token). */
  secrets: () => readonly string[]
}

type Decision = { outcome: WakeOutcome } | { wait: Promise<WakeOutcome> }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}

function isNotFound(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause.name === 'SessionPersistenceNotFoundError' || cause.name === 'SessionQueryError' && /not.found/i.test(cause.message)) return true
  }
  return false
}

export class RaftRuntime {
  private current: LiveSession | undefined
  /** Rotated-out sessions still finishing their work; they keep reporting activity until disposed. */
  private readonly retiring = new Map<string, LiveSession>()
  private chain: Promise<unknown> = Promise.resolve()
  private pending: { sessionId: SessionId; messageId: MessageId } | undefined
  private windowEnd = 0
  private tail: Array<(outcome: WakeOutcome) => void> = []
  private tailTimer: NodeJS.Timeout | undefined
  private recoverTimer: NodeJS.Timeout | undefined
  private recoverDelayMs = 1000
  private disposed = false
  private lastSessionId: string | undefined
  private injecting: { id: MessageId; claimed: boolean } | undefined
  /**
   * The running turn that one of our notices started, until it ends, and
   * whether it has started a `raft message check` call yet. While it has not,
   * that coming check drains whatever a new wake announces.
   */
  private noticeTurn: { sessionId: string; turn: number; checked: boolean } | undefined
  /** Wake counter for the per-wake debug log. */
  private wakes = 0

  constructor(private readonly options: RuntimeOptions) {}

  /** The current session id, reported to the bridge as `runtimeSession`. */
  runtimeSession(): string | undefined {
    return this.current?.id ?? this.lastSessionId
  }

  /** Turns completed in the current session (for status and tests). */
  currentTurns(): number {
    return this.current?.turns ?? 0
  }

  /** The current live agent, when one is attached. */
  currentAgent(): Agent | undefined {
    return this.current?.handle.agent
  }

  /** Run `task` after every earlier wake, rotation or recovery step settles. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Resume the session named by the state file, or create the first one. */
  async start(): Promise<void> {
    await this.serial(async () => {
      const { config, logger } = this.options
      const persistent = this.options.ctx.get('sessionPersistence') !== undefined
      if (!persistent) {
        logger.warn('raft-channel: no sessionPersistence service is mounted; the Raft session lives in memory and is lost at exit')
      }
      let state
      try {
        state = await readState(config.stateFile)
      } catch (error) {
        logger.error(`raft-channel: ${errorText(error)}; starting a new session series`)
      }
      if (state !== undefined && state.sessionPrefix !== config.sessionPrefix) {
        logger.warn(`raft-channel: sessionPrefix changed (${state.sessionPrefix} -> ${config.sessionPrefix}); starting a new session series, ${state.sessionId} stays resumable`)
        state = undefined
      }
      let live: LiveSession
      // Set when the session we attach may hold (or have lost) a wake that
      // was answered 2xx before the previous process stopped.
      let rewake = false
      if (state !== undefined && persistent) {
        try {
          live = await this.resume(state.sessionId as SessionId, state.index)
          logger.info(`raft-channel: resumed ${live.id} (${live.turns} turns)`)
          rewake = needsRewake(live.handle.agent.session.snapshotEvents())
        } catch (error) {
          // A preset that cannot be resolved or mounted is a configuration
          // error: a new session would hit it too, or run under another preset.
          if (isAgentPresetError(error)) throw error
          if (errorName(error) === 'SessionAlreadyOwnedError') {
            throw new Error(`session ${state.sessionId} is already owned by a live writer; is another DSH process running Raft profile ${config.profile}?`)
          }
          if (isNotFound(error)) {
            // Created but never written to (no turn ran before the restart): reuse the id.
            logger.info(`raft-channel: ${state.sessionId} was never persisted; creating it now`)
            live = await this.createFrom(state.index, state.previousSessionId)
          } else {
            logger.error(`raft-channel: cannot resume ${state.sessionId} (${errorText(error)}); continuing in a new session`)
            live = await this.createFrom(state.index + 1, state.sessionId)
            // Whatever the unreadable session still owed is unknown: check once.
            rewake = true
          }
        }
      } else {
        live = await this.createFrom(state === undefined ? 1 : state.index + 1, state?.sessionId)
      }
      if (this.disposed) {
        await live.handle.dispose().catch(() => undefined)
        return
      }
      this.attach(live)
      if (rewake) this.rewake(live, 'the previous run')
    })
  }

  /**
   * Queue one fresh notice on a session re-attached after a stop that may have
   * dropped an acknowledged wake (the bridge would otherwise wait for its
   * reconciliation, about two minutes). At-least-once: the check is idempotent.
   */
  private rewake(live: LiveSession, why: string): void {
    try {
      this.inject(live)
      this.windowEnd = monotonicNow() + this.options.config.debounceMs
      this.options.logger.info(`raft-channel: ${why} left wake work in ${live.id} unfinished; queued a fresh wake notice`)
    } catch (error) {
      this.options.logger.error(`raft-channel: could not queue the recovery wake notice in ${live.id}: ${errorText(error)}`)
    }
  }

  private attach(live: LiveSession): void {
    this.current = live
    this.lastSessionId = live.id
  }

  private currentSelection(): ModelSelection {
    return this.options.ctx.agentDefaultModel.currentSelection()
  }

  private setupFor(selection: ModelSelectionRef, compose: Compose | undefined): AgentSetup {
    const text = orientationText(this.options.config.profile)
    return async (agentCtx: Context, agent: Agent): Promise<void> => {
      // Join the preset first (as the webhook creator does): in a registry
      // composition the preset carries every model-visible tool.
      if (compose !== undefined) await compose(agentCtx, agent)
      installModelSelection(agentCtx, selection)
      agentCtx.systemPrompt.section({ name: ORIENTATION_SECTION, order: ORIENTATION_ORDER, text, interpolate: false })
    }
  }

  private agentOptions(selection: ModelSelection) {
    return {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  }

  private async liveSession(index: number, handle: AgentHandle, selection: ModelSelectionRef, turns: number, preset: string | undefined): Promise<LiveSession> {
    const { activity, secrets } = this.options
    const id = handle.agent.session.id
    await this.registerWorkspace(handle.agent)
    this.checkTools(handle.agent, preset)
    const recorder = activity === undefined ? undefined : new ActivityRecorder(id, event => { activity.push(event) }, secrets)
    activity?.push(sessionLifecycleEvent('SessionStart', id))
    return { index, id, handle, turns, selection, recorder, preset }
  }

  /**
   * List the session under its cwd in the workspace registry (web UI), when
   * the composition has one. Idempotent for an already attached session; a
   * failure only costs the listing.
   */
  private async registerWorkspace(agent: Agent): Promise<void> {
    const registry = workspaceRegistry(this.options.ctx)
    if (registry === undefined) return
    const path = agent.session.header.cwd ?? this.options.config.cwd
    try {
      const workspace = await registry.create(path)
      await workspace.attachSession(agent.session.id)
    } catch (error) {
      this.options.logger.warn(`raft-channel: could not list ${agent.session.id} in workspace ${path}: ${errorText(error)}`)
    }
  }

  /**
   * Startup self-check: log the tools the agent's requests carry, and fail
   * loudly when none is a shell — the agent could not run `raft message
   * check`, and the bridge would re-wake it forever.
   */
  private checkTools(agent: Agent, preset: string | undefined): void {
    const { logger } = this.options
    const names = visibleToolNames(this.options.ctx, agent)
    const id = agent.session.id
    if (names === undefined) {
      logger.warn(`raft-channel: no tool registry is mounted; ${id} has no tools and cannot run the raft CLI`)
      return
    }
    const under = preset === undefined ? '' : ` (agent preset ${preset})`
    logger.info(`raft-channel: ${id}${under} sees ${names.length} tools: ${names.join(', ') || '(none)'}`)
    if (!names.some(name => SHELL_TOOLS.includes(name))) {
      logger.error(`raft-channel: ${id}${under} has no shell tool (${SHELL_TOOLS.join(' or ')}); it cannot run \`raft message check\` and every wake will be wasted. ${preset === undefined
        ? 'Mount a shell tool plugin in this profile.'
        : 'Set agentPreset to a preset that includes a shell tool.'}`)
    }
  }

  private async resume(id: SessionId, index: number): Promise<LiveSession> {
    const { ctx, config, logger } = this.options
    const selected = this.currentSelection()
    const selection: ModelSelectionRef = { current: selected, assembled: undefined }
    const presets = presetRegistry(ctx)
    // Resolved before the resume, so an unusable configured preset fails the
    // same way whether or not this session recorded its own.
    const fallback = presets === undefined ? undefined : await resolvePreset(presets, config.agentPreset)
    let mounted: string | undefined
    const compose: Compose | undefined = presets === undefined || fallback === undefined ? undefined : async (agentCtx, agent) => {
      const recorded = recordedPreset(agent.session)
      if (recorded === undefined) logger.info(`raft-channel: ${id} recorded no agent preset; mounting ${fallback}`)
      mounted = recorded ?? fallback
      await mountPreset(presets, agentCtx, mounted)
    }
    const handle = await ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: this.agentOptions(selected),
      setup: this.setupFor(selection, compose),
    })
    return this.liveSession(index, handle, selection, countTurns(handle.agent.session), mounted)
  }

  /** Create `<prefix>-<n>` for the first free n ≥ start and point the state file at it. */
  private async createFrom(start: number, previousSessionId?: string): Promise<LiveSession> {
    const { config, ctx } = this.options
    const presets = presetRegistry(ctx)
    const preset = presets === undefined ? undefined : await resolvePreset(presets, config.agentPreset)
    // Hold the resolved revision until the agent has joined it.
    const lease = presets === undefined || preset === undefined ? undefined : await acquirePreset(presets, preset)
    try {
      return await this.createWith(start, previousSessionId, presets === undefined || preset === undefined
        ? undefined
        : { id: preset, compose: agentCtx => mountPreset(presets, agentCtx, preset) })
    } finally {
      await lease?.[Symbol.asyncDispose]()
    }
  }

  private async createWith(start: number, previousSessionId: string | undefined, preset: { id: string; compose: Compose } | undefined): Promise<LiveSession> {
    const { config, ctx } = this.options
    for (let index = start; index < start + MAX_ID_PROBES; index += 1) {
      const id = `${config.sessionPrefix}-${index}` as SessionId
      if (ctx.agents.get(id) !== undefined) continue
      const selected = this.currentSelection()
      const selection: ModelSelectionRef = { current: selected, assembled: undefined }
      let handle: AgentHandle
      try {
        handle = await ctx.agents.create({
          sessionId: id,
          meta: { cwd: config.cwd, ...preset === undefined ? {} : { agentPreset: preset.id } },
          agentOptions: this.agentOptions(selected),
          setup: this.setupFor(selection, preset?.compose),
        })
      } catch (error) {
        if (errorName(error) === 'SessionAlreadyExistsError' || /already exists/.test(errorText(error))) continue
        throw error
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
        })
      } catch (error) {
        // The session is usable; only the pointer is stale, so a restart would
        // resume the previous session. Say so instead of failing the wake path.
        this.options.logger.error(`raft-channel: could not write ${config.stateFile}: ${errorText(error)}`)
      }
      this.options.logger.info(`raft-channel: created session ${id}${preset === undefined ? '' : ` under agent preset ${preset.id}`}`)
      return this.liveSession(index, handle, selection, 0, preset?.id)
    }
    throw new Error(`no free session id in ${config.sessionPrefix}-${start}..${start + MAX_ID_PROBES - 1}`)
  }

  /** Answer one wake POST: 2xx only once a notice is in (or already covering) the inbox. */
  async wake(): Promise<WakeOutcome> {
    if (this.disposed) return this.noSession('the Raft channel is shutting down')
    const decision = await this.serial(async (): Promise<Decision> => this.decide())
    return 'wait' in decision ? decision.wait : decision.outcome
  }

  private noSession(reason: string): WakeOutcome {
    return { ok: false, status: 503, failureClass: 'no_session', reason, retryAfterMs: 5000 }
  }

  private decide(): Decision {
    const wake = ++this.wakes
    const live = this.current
    if (live === undefined || this.disposed) return { outcome: this.noSession('no Raft agent session is attached yet') }
    const covered = this.coveredBy(live)
    if (covered !== undefined) {
      this.trace(wake, `coalesced: ${covered}`)
      return { outcome: { ok: true, runtimeSession: live.id } }
    }
    if (this.options.config.debounceMs > 0 && monotonicNow() < this.windowEnd) {
      this.trace(wake, 'held for the debounce window')
      return { wait: new Promise<WakeOutcome>(resolve => { this.tail.push(resolve); this.armTail() }) }
    }
    const outcome = this.injectOutcome(live)
    if (outcome.ok) this.trace(wake, 'injected')
    return { outcome }
  }

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
  private coveredBy(live: LiveSession): string | undefined {
    if (this.noticePending(live)) return 'unclaimed notice'
    if (this.preCheckTurn()) return 'pre-check turn'
    return undefined
  }

  /** Whether a notice-started turn of a session we still run has not started its check yet. */
  private preCheckTurn(): boolean {
    const turn = this.noticeTurn
    if (turn === undefined || turn.checked) return false
    return this.current?.id === turn.sessionId || this.retiring.has(turn.sessionId)
  }

  private trace(wake: number, what: string): void {
    this.options.logger.debug(`raft-channel: wake #${wake} ${what}`)
  }

  private armTail(): void {
    if (this.tailTimer !== undefined) return
    this.tailTimer = setTimeout(() => {
      this.tailTimer = undefined
      this.serial(async () => { this.flushTail() }).catch((error: unknown) => {
        this.options.logger.error(`raft-channel: wake flush failed: ${errorText(error)}`)
      })
    }, Math.max(0, this.windowEnd - monotonicNow()))
    this.tailTimer.unref()
  }

  /** Window close: one merged notice for every wake that arrived inside it. */
  private flushTail(): void {
    const waiters = this.tail.splice(0)
    if (waiters.length === 0) return
    const live = this.current
    let outcome: WakeOutcome
    if (live === undefined || this.disposed) outcome = this.noSession('no Raft agent session is attached')
    else {
      const covered = this.coveredBy(live)
      if (covered !== undefined) {
        outcome = { ok: true, runtimeSession: live.id }
        this.options.logger.debug(`raft-channel: ${waiters.length} held wake(s) coalesced: ${covered}`)
      } else {
        outcome = this.injectOutcome(live)
        if (outcome.ok) {
          this.options.logger.debug(`raft-channel: debounce window closed: 1 held wake injected${waiters.length > 1 ? `, ${waiters.length - 1} coalesced: debounce` : ''}`)
        }
      }
    }
    for (const resolve of waiters) resolve(outcome)
  }

  private noticePending(live: LiveSession): boolean {
    const pending = this.pending
    if (pending === undefined || pending.sessionId !== live.id) return false
    return live.handle.agent.inbox.nextTurn.some(message => message.id === pending.messageId)
  }

  private injectOutcome(live: LiveSession): WakeOutcome {
    try {
      this.inject(live)
      this.windowEnd = monotonicNow() + this.options.config.debounceMs
      return { ok: true, runtimeSession: live.id }
    } catch (error) {
      this.options.logger.error(`raft-channel: wake injection into ${live.id} failed: ${errorText(error)}`)
      return { ok: false, status: 500, failureClass: 'injection_failed', reason: `wake notice was not queued: ${errorText(error)}` }
    }
  }

  /**
   * Queue the fixed notice as a follow-up turn. Source kind 'user' is required:
   * the slice context policy only seals text-only user messages of that kind,
   * any other kind would stay raw in every later request.
   * @throws when the agent is gone or the inbox did not accept the message.
   */
  private inject(live: LiveSession): void {
    const agent = live.handle.agent
    if (this.options.ctx.agents.get(live.id) !== agent) throw new Error(`agent ${live.id} is no longer live`)
    live.selection.current = this.currentSelection()
    const message = createUserMessage({ content: [{ type: 'text', text: WAKE_NOTICE }], source: { kind: 'user' } })
    // An idle driver claims the message synchronously inside followup(), so
    // "accepted" means still queued or already claimed by a turn.
    this.injecting = { id: message.id, claimed: false }
    try {
      agent.followup(message)
      const accepted = this.injecting.claimed || agent.inbox.nextTurn.some(queued => queued.id === message.id)
      if (!accepted) throw new Error('the follow-up did not enter the agent inbox')
    } finally {
      this.injecting = undefined
    }
    this.pending = { sessionId: live.id, messageId: message.id }
  }

  /**
   * `agent/inbox/claimed` feed: marks a notice claimed during its own
   * followup(), and notes the turn one of our notices starts. Notices are
   * queued as next-turn input, so they are claimed only at a turn's start.
   */
  onClaimed(sessionId: string, messageId: MessageId, turn: number): void {
    const injecting = this.injecting
    const ours = injecting?.id === messageId
    if (ours) injecting!.claimed = true
    const pending = this.pending
    if (ours || pending !== undefined && pending.sessionId === sessionId && pending.messageId === messageId) {
      this.noticeTurn = { sessionId, turn, checked: false }
    }
  }

  /**
   * Observe one appended session event of any session; ours feed activity and,
   * for the current session, turn counting and rotation.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    const live = this.current?.id === session.id ? this.current : this.retiring.get(session.id)
    if (live === undefined) return
    live.recorder?.record(event)
    this.trackCheck(session.id, event)
    if (event.type !== 'turn/end' || live !== this.current || this.disposed) return
    live.turns += 1
    this.serial(async () => { await this.maybeRotate(live) }).catch((error: unknown) => {
      this.options.logger.error(`raft-channel: rotation of ${live.id} failed: ${errorText(error)}; staying on it`)
    })
  }

  /** Mark the notice-started turn checked at its first `raft message check` call; forget it when it ends. */
  private trackCheck(sessionId: string, event: SessionEvent): void {
    const turn = this.noticeTurn
    if (turn === undefined || turn.sessionId !== sessionId) return
    if (event.type === 'tool/call') {
      const data = (event as SessionEvent<'tool/call'>).data
      if (!turn.checked && data.turn === turn.turn && isRaftCheckCall(data.arguments)) {
        turn.checked = true
        this.options.logger.debug(`raft-channel: ${sessionId} turn ${turn.turn} started raft message check`)
      }
    } else if (event.type === 'turn/end') {
      if ((event as SessionEvent<'turn/end'>).data.turn === turn.turn) this.noticeTurn = undefined
    }
  }

  private historyChars(live: LiveSession): number {
    return JSON.stringify(live.handle.agent.session.deriveMessages()).length
  }

  private async maybeRotate(live: LiveSession): Promise<void> {
    if (live !== this.current || this.disposed) return
    const { maxTurns, maxHistoryChars } = this.options.config.rotate
    const turnsOver = live.turns >= maxTurns
    const chars = turnsOver ? 0 : this.historyChars(live)
    if (!turnsOver && chars < maxHistoryChars) return
    const next = await this.createFrom(live.index + 1, live.id)
    if (this.disposed) {
      await next.handle.dispose().catch(() => undefined)
      return
    }
    this.attach(next)
    // A notice still waiting in the old inbox moves with the rotation; one
    // already claimed is handled there, so nothing is lost either way.
    const pending = this.pending
    let carried = false
    if (pending !== undefined && pending.sessionId === live.id) {
      carried = live.handle.agent.inbox.remove(pending.messageId)
      this.pending = undefined
    }
    if (carried) {
      try {
        this.inject(next)
      } catch (error) {
        this.options.logger.error(`raft-channel: could not move the pending wake notice to ${next.id}: ${errorText(error)}; the bridge's reconciliation will re-wake`)
      }
    }
    this.options.logger.info(`raft-channel: rotated ${live.id} -> ${next.id} (${live.turns} turns${turnsOver ? '' : `, ${chars} history chars`})`)
    this.retire(live)
  }

  private retire(live: LiveSession): void {
    this.retiring.set(live.id, live)
    const done = (): void => { this.retiring.delete(live.id) }
    live.handle.agent.whenIdle()
      .then(() => live.handle.dispose())
      .then(done, (error: unknown) => {
        done()
        this.options.logger.warn(`raft-channel: retiring ${live.id} failed: ${errorText(error)}`)
      })
  }

  /**
   * The current agent left the registry without our asking (for example the
   * agent-loop plugin reloaded): re-attach its session with backoff.
   */
  onAgentDisposed(agent: Agent): void {
    const live = this.current
    if (this.disposed || live === undefined || live.handle.agent !== agent) return
    this.options.logger.warn(`raft-channel: agent ${live.id} was disposed externally; re-attaching`)
    this.current = undefined
    this.pending = undefined
    if (this.noticeTurn?.sessionId === live.id) this.noticeTurn = undefined
    this.scheduleRecover(live)
  }

  private scheduleRecover(lost: LiveSession): void {
    if (this.recoverTimer !== undefined || this.disposed) return
    const delay = this.recoverDelayMs
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = undefined
      this.serial(async () => {
        if (this.disposed || this.current !== undefined) return
        const persistent = this.options.ctx.get('sessionPersistence') !== undefined
        const live = persistent ? await this.resume(lost.id, lost.index) : await this.createFrom(lost.index + 1, lost.id)
        if (this.disposed) {
          await live.handle.dispose().catch(() => undefined)
          return
        }
        this.attach(live)
        this.recoverDelayMs = 1000
        this.options.logger.info(`raft-channel: re-attached ${live.id}`)
        // The dispose canceled any queued notice and interrupted any running
        // turn; the resumed log (or, in memory, the lost one) shows which.
        const events = persistent ? live.handle.agent.session.snapshotEvents() : lost.handle.agent.session.snapshotEvents()
        if (needsRewake(events)) this.rewake(live, 'the external dispose')
      }).catch((error: unknown) => {
        this.recoverDelayMs = Math.min(this.recoverDelayMs * 2, 60_000)
        this.options.logger.error(`raft-channel: re-attaching ${lost.id} failed: ${errorText(error)}; retrying in ${this.recoverDelayMs}ms`)
        this.scheduleRecover(lost)
      })
    }, delay)
    this.recoverTimer.unref()
  }

  /** Stop answering wakes and dispose every agent this runtime owns. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.tailTimer !== undefined) clearTimeout(this.tailTimer)
    if (this.recoverTimer !== undefined) clearTimeout(this.recoverTimer)
    this.tailTimer = undefined
    this.recoverTimer = undefined
    const waiters = this.tail.splice(0)
    for (const resolve of waiters) resolve(this.noSession('the Raft channel is shutting down'))
    await this.chain
    const lives = [...this.current === undefined ? [] : [this.current], ...this.retiring.values()]
    this.current = undefined
    this.retiring.clear()
    for (const live of lives) {
      this.options.activity?.push(sessionLifecycleEvent('SessionEnd', live.id))
      await live.handle.dispose().catch((error: unknown) => {
        this.options.logger.warn(`raft-channel: disposing ${live.id} failed: ${errorText(error)}`)
      })
    }
  }
}

/** Completed turns recorded in a session's log (read once, at resume). */
function countTurns(session: Session): number {
  let turns = 0
  for (const event of session.snapshotEvents()) if (event.type === 'turn/end') turns += 1
  return turns
}
