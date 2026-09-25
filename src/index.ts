/**
 * @dsh-external/dsh-raft-channel — makes a DSH agent a Raft external agent.
 *
 * The plugin owns exactly what the wake-endpoint contract gives the runtime:
 * a localhost endpoint the supervised `raft agent bridge` child POSTs
 * content-free wakes to, and a fixed wake notice injected into one persistent
 * agent session. The agent reads and replies through the `raft` CLI itself;
 * message bodies never cross this process.
 */
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-session'
import { ActivityQueue } from './activity.js'
import { BridgeSupervisor, type BridgeStatus } from './bridge.js'
import { isLoopbackHost, resolveConfig, type Config, type ResolvedConfig } from './config.js'
import { RaftRuntime } from './runtime.js'
import { startChannelServer, type ChannelServer } from './server.js'

export type { Config, ResolvedConfig } from './config.js'
export { RaftChannelConfigError, resolveConfig } from './config.js'
export { WAKE_NOTICE, orientationText, ORIENTATION_SECTION } from './text.js'
export { ActivityQueue, ActivityRecorder, capContent, redactCredentials, validateActivityEvent, CONTENT_CAP } from './activity.js'
export type { ActivityEvent, DrainResult } from './activity.js'
export { BridgeSupervisor, buildBridgeArgs, buildBridgeEnv, bridgeSpawnPlan, TERMINAL_ERROR_CODES } from './bridge.js'
export type { BridgeLogger, BridgeOptions, BridgeStatus, BridgeState } from './bridge.js'
export { startChannelServer, validateWakeBody, WAKE_SCHEMA } from './server.js'
export type { WakeOutcome, FailureClass } from './server.js'
export { readState, writeState, STATE_SCHEMA } from './state.js'
export type { ChannelState } from './state.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    raftChannel: RaftChannel
  }
}

export interface RaftChannelStatus {
  state: 'starting' | 'ready' | 'failed' | 'disposed'
  profile: string
  /** Wake endpoint URL once listening. */
  endpoint?: string
  /** Current session id (the `runtimeSession` every wake answer carries). */
  runtimeSession?: string
  turns: number
  bridge?: BridgeStatus
  activityQueued?: number
  error?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RaftChannel extends Service {
  static inject = ['agents', 'sessions', 'agentDefaultModel', 'systemPrompt']

  private readonly settings: ResolvedConfig
  private readonly runtime: RaftRuntime
  private readonly activity: ActivityQueue | undefined
  private server: ChannelServer | undefined
  private bridge: BridgeSupervisor | undefined
  private state: RaftChannelStatus['state'] = 'starting'
  private failure: string | undefined
  private readonly ready: Promise<void>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'raftChannel')
    // Fail fast: a bad profile or a missing expected Agent id stops the load here.
    const settings = resolveConfig(config, process.env, resolveDshHome())
    this.settings = settings
    const logger = ctx.logger
    if (!isLoopbackHost(settings.host)) {
      logger.warn(`raft-channel: wake endpoint binds ${settings.host}, which is not loopback; the token is the only guard`)
    }
    // Minted per process, handed only to the bridge child through its env.
    const token = randomBytes(32).toString('base64url')
    this.activity = settings.activity.enabled ? new ActivityQueue(settings.activity.queueCap) : undefined
    this.runtime = new RaftRuntime({ ctx, config: settings, logger, activity: this.activity, secrets: () => [token] })

    // The agent's shell inherits this environment; when the profile came only
    // from config, export it so `raft` in that shell acts as the same identity.
    let exported = false
    if (settings.exportProfile && process.env.RAFT_PROFILE === undefined) {
      process.env.RAFT_PROFILE = settings.profile
      exported = true
    }

    ctx.on('session/event', (session, event) => {
      try {
        this.runtime.onSessionEvent(session, event)
      } catch (error) {
        logger.warn(`raft-channel: session event handling failed: ${errorText(error)}`)
      }
    })
    ctx.on('agent/inbox/claimed', ({ message }) => { this.runtime.onClaimed(message.id) })
    ctx.on('agent/disposed', ({ agent }) => { this.runtime.onAgentDisposed(agent) })

    let disposed = false
    const start = async (): Promise<void> => {
      await mkdir(settings.cwd, { recursive: true })
      // Loader siblings mount concurrently; create the agent only once the whole
      // application is composed (tools, adapters, context policy).
      const loader = ctx.get('loader') as { await?: () => Promise<unknown> } | undefined
      await loader?.await?.()
      if (disposed) return
      await this.runtime.start()
      if (disposed) return
      const server = await startChannelServer({
        host: settings.host,
        port: settings.port,
        token,
        wake: () => this.runtime.wake(),
        activityQueue: this.activity,
        onError: error => { logger.warn(`raft-channel: endpoint error: ${errorText(error)}`) },
      })
      if (disposed) {
        await server.close()
        return
      }
      this.server = server
      logger.info(`raft-channel: wake endpoint ${server.url} serving session ${this.runtime.runtimeSession()} (profile ${settings.profile})`)
      if (settings.bridge.enabled) {
        const bridge = new BridgeSupervisor({
          command: settings.raftBin,
          profile: settings.profile,
          expectedAgentId: settings.expectedAgentId!,
          endpoint: server.url,
          token,
          runtimeSession: () => this.runtime.runtimeSession() ?? 'none',
          pollIntervalMs: settings.bridge.pollIntervalMs,
          restartBackoffMs: settings.bridge.restartBackoffMs,
          logger,
        })
        this.bridge = bridge
        bridge.start()
      } else {
        logger.warn('raft-channel: bridge.enabled is false; nothing will POST wakes (the endpoint token is private to this process)')
      }
      this.state = 'ready'
    }
    this.ready = start().catch((error: unknown) => {
      this.state = 'failed'
      this.failure = errorText(error)
      logger.error(`raft-channel: failed to start: ${this.failure}`)
    })

    ctx.effect(() => async () => {
      disposed = true
      this.state = 'disposed'
      // No new wakes first, then the endpoint, then the agents.
      await this.bridge?.stop().catch(() => undefined)
      await this.server?.close().catch(() => undefined)
      await this.runtime.dispose().catch((error: unknown) => { logger.warn(`raft-channel: dispose: ${errorText(error)}`) })
      if (exported && process.env.RAFT_PROFILE === settings.profile) delete process.env.RAFT_PROFILE
    }, 'raft-channel')
  }

  /** Resolves once startup finished (or failed; see {@link status}). */
  whenReady(): Promise<void> {
    return this.ready
  }

  status(): RaftChannelStatus {
    return {
      state: this.state,
      profile: this.settings.profile,
      turns: this.runtime.currentTurns(),
      ...this.server === undefined ? {} : { endpoint: this.server.url },
      ...this.runtime.runtimeSession() === undefined ? {} : { runtimeSession: this.runtime.runtimeSession() },
      ...this.bridge === undefined ? {} : { bridge: this.bridge.getStatus() },
      ...this.activity === undefined ? {} : { activityQueued: this.activity.size },
      ...this.failure === undefined ? {} : { error: this.failure },
    }
  }
}

export default RaftChannel
