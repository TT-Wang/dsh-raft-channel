/**
 * Agent-preset composition: in a web-app-style composition (preset registry
 * mounted) model-visible tools live in presets, so the Raft agent must join
 * one on create and on resume; without the registry nothing changes. The
 * startup self-check makes a shell-less agent loud.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { recordedPreset, type AgentPresetsView } from '../src/index.js'
import { addGlobalTool, agentTools, FAKE_RAFT, fakeRaftRecords, host, mountChannel, postWake, presetWith, scratch, until, type Host, type HostOptions } from './harness.js'

// The structural view the runtime uses must stay assignable from the real registry.
const pinned: (registry: AgentPresetRegistry) => AgentPresetsView = registry => registry
void pinned

const AGENT_ID = 'agent-1'
const SLICE_TOOLS = ['expand_result', 'recall_search', 'recall_step', 'recall_turn']
const REGISTRY: NonNullable<HostOptions['presets']> = {
  default: 'standard',
  definitions: [presetWith('standard', ['bash', 'read', 'write']), presetWith('minimal', ['pwsh']), presetWith('talk-only', ['read'])],
}

/** Stand-in for dsh-workspace's registry: records calls, idempotent attach like the real one. */
class FakeWorkspaces extends Service {
  readonly calls: string[] = []
  readonly attached = new Set<string>()
  fail = false
  constructor(ctx: Context) { super(ctx, 'workspaceRegistry' as never) }
  async create(path: string) {
    this.calls.push(`create ${path}`)
    if (this.fail) throw new Error('workspace store unavailable')
    return {
      attachSession: async (sessionId: string) => {
        this.calls.push(`attach ${sessionId}`)
        this.attached.add(sessionId)
      },
    }
  }
}

describe('agent presets', () => {
  let home: string
  let root: string
  let log: string
  const hosts: Host[] = []

  beforeEach(() => {
    home = scratch('preset')
    root = join(home, 'sessions')
    log = join(home, 'fake-raft.log')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('FAKE_RAFT_LOG', log)
    vi.stubEnv('FAKE_RAFT_SCENARIO', 'serve')
    vi.stubEnv('RAFT_PROFILE', undefined)
    vi.stubEnv('SLOCK_PROFILE', undefined)
  })

  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.ctx.fiber.dispose()
    vi.unstubAllEnvs()
  })

  async function boot(options: HostOptions & { workspaces?: boolean } = {}, extra: Record<string, unknown> = {}) {
    const h = await host({ persistenceRoot: root, ...options })
    hosts.push(h)
    // Slice-like tools are registered globally in every composition.
    for (const name of SLICE_TOOLS) addGlobalTool(h, name)
    let workspaces: FakeWorkspaces | undefined
    if (options.workspaces === true) {
      await h.ctx.plugin(FakeWorkspaces)
      workspaces = (h.ctx.get as (name: string) => unknown)('workspaceRegistry') as FakeWorkspaces
    }
    const before = fakeRaftRecords(log).length
    const { channel } = await mountChannel(h, { profile: 'p', expectedAgentId: AGENT_ID, raftBin: FAKE_RAFT, debounceMs: 0, ...extra })
    if (channel.status().state === 'ready') await until(() => fakeRaftRecords(log).length > before, 10_000, 'bridge spawn')
    const token = fakeRaftRecords(log).at(-1)?.env?.RAFT_CHANNEL_TOKEN
    return { h, channel, token, url: channel.status().endpoint, workspaces }
  }

  /** Run one wake turn so the session is persisted (an unwritten one is re-created, not resumed). */
  async function persistTurn(b: Awaited<ReturnType<typeof boot>>, id = 'raft-p-1'): Promise<void> {
    const before = b.h.adapter.requests.length
    expect((await postWake(b.url!, b.token)).body.ok).toBe(true)
    await until(() => b.h.adapter.requests.length > before, 5000, 'wake turn')
    await b.h.ctx.agents.get(id as never)!.whenIdle()
  }

  async function restart(): Promise<void> {
    for (const h of hosts.splice(0)) await h.ctx.fiber.dispose()
  }

  const header = (h: Host, id: string) => h.ctx.agents.get(id as never)!.session.header
  const errors = (h: Host) => h.logs.filter(line => line.type === 'error').map(line => line.text)

  it('a created agent joins the default preset and sees its shell tool beside the global slice tools', async () => {
    const { h, channel } = await boot({ presets: REGISTRY, globalShell: false })
    expect(channel.status().state).toBe('ready')
    expect(agentTools(h, 'raft-p-1')).toEqual(['bash', ...SLICE_TOOLS, 'echo', 'read', 'write'].sort())
    expect(header(h, 'raft-p-1').agentPreset).toBe('standard')
    // Globally the composition has no shell: only the preset gives it one.
    expect(h.ctx.tools.schemas().map(schema => schema.name)).not.toContain('bash')
    expect(h.logs.some(line => line.type === 'info' && /raft-p-1 \(agent preset standard\) sees 8 tools: .*bash/.test(line.text))).toBe(true)
    expect(errors(h)).toEqual([])
  })

  it('a rotated session joins the preset too', async () => {
    const { h, url, token } = await boot({ presets: REGISTRY, globalShell: false }, { rotate: { maxTurns: 1 } })
    expect((await postWake(url!, token)).body.ok).toBe(true)
    await until(() => h.ctx.agents.get('raft-p-2' as never) !== undefined, 10_000, 'rotation')
    expect(agentTools(h, 'raft-p-2')).toContain('bash')
    expect(header(h, 'raft-p-2').agentPreset).toBe('standard')
  })

  it('honours an explicit agentPreset', async () => {
    const { h } = await boot({ presets: REGISTRY, globalShell: false }, { agentPreset: 'minimal' })
    expect(agentTools(h, 'raft-p-1')).toEqual(['pwsh', ...SLICE_TOOLS, 'echo'].sort())
    expect(header(h, 'raft-p-1').agentPreset).toBe('minimal')
    expect(errors(h)).toEqual([])
  })

  it('resuming a session that recorded no preset mounts the default', async () => {
    // Created before this fix (or under a registry-free composition): no agentPreset in its header.
    const first = await boot()
    expect(header(first.h, 'raft-p-1').agentPreset).toBeUndefined()
    await persistTurn(first)
    await restart()

    const second = await boot({ presets: REGISTRY, globalShell: false })
    expect(second.channel.status()).toMatchObject({ state: 'ready', runtimeSession: 'raft-p-1' })
    expect(agentTools(second.h, 'raft-p-1')).toContain('bash')
    expect(second.h.logs.some(line => line.text.includes('raft-p-1 recorded no agent preset; mounting standard'))).toBe(true)
    expect(errors(second.h)).toEqual([])
  })

  it('a resumed session keeps the preset it recorded, and a preset-less one follows agentPreset', async () => {
    await persistTurn(await boot({ presets: REGISTRY, globalShell: false }, { agentPreset: 'minimal' }))
    await restart()
    const second = await boot({ presets: REGISTRY, globalShell: false })
    expect(second.channel.status().runtimeSession).toBe('raft-p-1')
    expect(agentTools(second.h, 'raft-p-1')).toContain('pwsh')
    expect(agentTools(second.h, 'raft-p-1')).not.toContain('bash')
  })

  it('an unknown configured preset fails startup with the registry error and creates nothing', async () => {
    const { h, channel } = await boot({ presets: REGISTRY, globalShell: false }, { agentPreset: 'nope' })
    expect(channel.status().state).toBe('failed')
    expect(channel.status().error).toMatch(/agent preset "nope" \(config agentPreset\) cannot be resolved: Unknown agent preset: nope/)
    expect(h.ctx.agents.get('raft-p-1' as never)).toBeUndefined()
    expect(errors(h).some(text => text.includes('failed to start') && text.includes('Unknown agent preset: nope'))).toBe(true)
  })

  it('an unknown preset also fails a resume instead of rolling to a new session', async () => {
    await persistTurn(await boot({ presets: REGISTRY, globalShell: false }))
    await restart()
    const { h, channel } = await boot({ presets: REGISTRY, globalShell: false }, { agentPreset: 'nope' })
    expect(channel.status().state).toBe('failed')
    expect(h.ctx.agents.get('raft-p-1' as never)).toBeUndefined()
    expect(h.ctx.agents.get('raft-p-2' as never)).toBeUndefined()
  })

  it('a session recording a preset the registry no longer declares fails startup', async () => {
    await persistTurn(await boot({ presets: REGISTRY, globalShell: false }, { agentPreset: 'minimal' }))
    await restart()
    const { h, channel } = await boot({ presets: { default: 'standard', definitions: [presetWith('standard', ['bash'])] }, globalShell: false })
    expect(channel.status().state).toBe('failed')
    expect(channel.status().error).toMatch(/Unknown agent preset: minimal/)
    expect(h.ctx.agents.get('raft-p-2' as never)).toBeUndefined()
  })

  it('without the registry the agent keeps the global tools and records no preset', async () => {
    const { h, channel } = await boot()
    expect(channel.status().state).toBe('ready')
    expect(agentTools(h, 'raft-p-1')).toEqual(['bash', ...SLICE_TOOLS, 'echo'].sort())
    expect(header(h, 'raft-p-1').agentPreset).toBeUndefined()
    expect(errors(h)).toEqual([])
  })

  it('the self-check logs an error when the agent has no shell tool', async () => {
    const withPreset = await boot({ presets: REGISTRY, globalShell: false }, { agentPreset: 'talk-only' })
    expect(withPreset.channel.status().state).toBe('ready')
    expect(errors(withPreset.h)).toEqual([expect.stringMatching(/raft-p-1 \(agent preset talk-only\) has no shell tool \(bash or pwsh\).*raft message check.*agentPreset/)])
    await restart()

    // The live bug's shape: the agent sees only the global slice tools.
    const presetless = await boot({ globalShell: false })
    expect(errors(presetless.h)).toEqual([expect.stringMatching(/raft-p-1 has no shell tool/)])
    expect(presetless.h.logs.some(line => line.type === 'info' && /raft-p-1 sees 5 tools: .*recall_search/.test(line.text))).toBe(true)
  })

  it('lists the session in the workspace registry on create and re-attaches on resume', async () => {
    const first = await boot({ workspaces: true })
    const cwd = join(home, 'raft-workspaces', 'p')
    expect(first.workspaces!.calls).toEqual([`create ${cwd}`, 'attach raft-p-1'])
    await persistTurn(first)
    await restart()
    const second = await boot({ workspaces: true })
    expect(second.channel.status().state).toBe('ready')
    expect(second.h.logs.some(line => line.text.includes('resumed raft-p-1'))).toBe(true)
    expect(second.workspaces!.calls).toEqual([`create ${cwd}`, 'attach raft-p-1'])
    expect(second.h.logs.filter(line => line.type === 'warn' || line.type === 'error')).toEqual([])
  })

  it('a failing workspace registry only warns', async () => {
    const h = await host({ persistenceRoot: root })
    hosts.push(h)
    await h.ctx.plugin(FakeWorkspaces)
    ;((h.ctx.get as (name: string) => unknown)('workspaceRegistry') as FakeWorkspaces).fail = true
    const { channel } = await mountChannel(h, { profile: 'p', expectedAgentId: AGENT_ID, raftBin: FAKE_RAFT, debounceMs: 0 })
    expect(channel.status().state).toBe('ready')
    expect(h.logs.some(line => line.type === 'warn' && line.text.includes('could not list raft-p-1 in workspace'))).toBe(true)
  })
})

describe('recordedPreset', () => {
  const session = (agentPreset: string | undefined, events: unknown[]) => ({
    id: 's' as never,
    header: { version: 4, id: 's', createdAt: 0, isSeeded: false, ...agentPreset === undefined ? {} : { agentPreset } } as never,
    snapshotEvents: () => events as SessionEvent[],
  })

  it('reads the header advanced by the last agent-preset/selected event', () => {
    expect(recordedPreset(session(undefined, []))).toBeUndefined()
    expect(recordedPreset(session('standard', []))).toBe('standard')
    expect(recordedPreset(session('standard', [
      { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
      { type: 'turn/start', data: {} },
      { type: 'agent-preset/selected', data: { agentPreset: 'review' } },
    ]))).toBe('review')
  })

  it('rejects a malformed selection record instead of reading it as none', () => {
    expect(() => recordedPreset(session(undefined, [{ type: 'agent-preset/selected', data: {} }]))).toThrow(/malformed/)
  })
})
