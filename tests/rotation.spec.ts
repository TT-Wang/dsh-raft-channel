/** Persistent session: resume across restarts, rotation past thresholds, no lost wakes. */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WAKE_NOTICE } from '../src/index.js'
import { FAKE_RAFT, fakeRaftRecords, host, mountChannel, postWake, scratch, until, wakeBody, type Host } from './harness.js'

const AGENT_ID = 'agent-1'

function notices(h: Host, sessionId: string): number {
  const agent = h.ctx.agents.get(sessionId as never)
  if (agent === undefined) return -1
  return (agent.session.snapshotEvents() as readonly SessionEvent[])
    .filter(event => event.type === 'user/message' && (event as SessionEvent<'user/message'>).data.content.some(block => block.type === 'text' && block.text === WAKE_NOTICE))
    .length
}

describe('persistent Raft session', () => {
  let home: string
  let root: string
  let log: string
  const hosts: Host[] = []

  beforeEach(() => {
    home = scratch('rot')
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

  async function boot(extra: Record<string, unknown> = {}) {
    const h = await host({ persistenceRoot: root })
    hosts.push(h)
    const before = fakeRaftRecords(log).length
    const { channel, fiber } = await mountChannel(h, { profile: 'p', expectedAgentId: AGENT_ID, raftBin: FAKE_RAFT, debounceMs: 0, ...extra })
    await until(() => fakeRaftRecords(log).length > before, 10_000, 'bridge spawn')
    const token = fakeRaftRecords(log).at(-1)!.env.RAFT_CHANNEL_TOKEN!
    return { h, channel, fiber, token, url: channel.status().endpoint! }
  }

  const state = () => JSON.parse(readFileSync(join(home, 'raft-channel', 'p.json'), 'utf8')) as Record<string, unknown>

  it('resumes the state-file session after a full restart', async () => {
    const first = await boot()
    expect((await postWake(first.url, first.token)).body).toEqual({ ok: true, runtimeSession: 'raft-p-1' })
    await first.h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    await first.h.ctx.fiber.dispose()
    hosts.splice(0)

    const second = await boot()
    expect(second.channel.status()).toMatchObject({ runtimeSession: 'raft-p-1', turns: 1 })
    expect(fakeRaftRecords(log).at(-1)!.argv).toContain('raft-p-1')
    expect(second.token).not.toBe(first.token)
    expect((await postWake(second.url, second.token)).body).toEqual({ ok: true, runtimeSession: 'raft-p-1' })
    await second.h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    expect(notices(second.h, 'raft-p-1')).toBe(2)
    expect(state()).toMatchObject({ index: 1, sessionId: 'raft-p-1' })
  })

  it('rotates after maxTurns: later wakes go to the next session, the old one stays resumable, nothing is lost', async () => {
    const { h, channel, token, url } = await boot({ rotate: { maxTurns: 2 } })
    for (const n of [1, 2]) {
      expect((await postWake(url, token, wakeBody(n))).body).toEqual({ ok: true, runtimeSession: 'raft-p-1' })
      await h.ctx.agents.get('raft-p-1' as never)?.whenIdle()
    }
    await until(() => channel.status().runtimeSession === 'raft-p-2', 5000, 'rotation')
    expect(state()).toMatchObject({ index: 2, sessionId: 'raft-p-2', previousSessionId: 'raft-p-1' })
    expect((await postWake(url, token, wakeBody(3))).body).toEqual({ ok: true, runtimeSession: 'raft-p-2' })
    await h.ctx.agents.get('raft-p-2' as never)!.whenIdle()
    expect(notices(h, 'raft-p-2')).toBe(1)
    await until(() => h.ctx.agents.get('raft-p-1' as never) === undefined, 5000, 'old session retired')
    // Still resumable, with both of its turns.
    const resumed = await h.ctx.agents.resume({ resumeSessionId: 'raft-p-1' as never })
    expect(notices(h, 'raft-p-1')).toBe(2)
    await resumed.dispose()
  })

  it('a wake queued while the rotating turn runs is delivered in one of the two sessions', async () => {
    const { h, channel, token, url } = await boot({ rotate: { maxTurns: 1 } })
    let release!: () => void
    h.adapter.gate = new Promise<void>(resolve => { release = resolve })
    expect((await postWake(url, token, wakeBody(1))).body.ok).toBe(true)
    await until(() => h.adapter.requests.length === 1, 5000, 'turn 1 in flight')
    const queued = await postWake(url, token, wakeBody(2))
    expect(queued.body).toEqual({ ok: true, runtimeSession: 'raft-p-1' })
    h.adapter.gate = undefined
    release()
    await until(() => channel.status().runtimeSession === 'raft-p-2', 5000, 'rotation')
    await until(() => h.adapter.requests.length === 2, 5000, 'second notice handled')
    await h.ctx.agents.get('raft-p-2' as never)?.whenIdle()
    const total = h.adapter.requests.filter(request => request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === WAKE_NOTICE))).length
    expect(total).toBe(2)
  })

  it('rotates on serialized history size', async () => {
    const { h, channel, token, url } = await boot({ rotate: { maxHistoryChars: 100 } })
    await postWake(url, token)
    await h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    await until(() => channel.status().runtimeSession === 'raft-p-2', 5000, 'size rotation')
    expect(state()).toMatchObject({ index: 2, sessionId: 'raft-p-2' })
    // The bridge keeps running: the answer carries the new runtimeSession, no restart needed.
    expect(channel.status().bridge).toMatchObject({ state: 'running', restartCount: 0 })
  })

  it('re-creates the state-file session when it was never written to', async () => {
    const first = await boot()
    await first.h.ctx.fiber.dispose()
    hosts.splice(0)
    const second = await boot()
    expect(second.channel.status().runtimeSession).toBe('raft-p-1')
    expect(second.h.logs.filter(line => line.type === 'error')).toEqual([])
    expect(second.h.logs.some(line => line.text.includes('never persisted') || line.text.includes('resumed raft-p-1'))).toBe(true)
  })

  it('skips an occupied id when the state file is gone', async () => {
    const first = await boot()
    await postWake(first.url, first.token)
    await first.h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    await first.h.ctx.fiber.dispose()
    hosts.splice(0)
    const { rmSync } = await import('node:fs')
    rmSync(join(home, 'raft-channel'), { recursive: true, force: true })
    const second = await boot()
    expect(second.channel.status().runtimeSession).toBe('raft-p-2')
    expect(state()).toMatchObject({ index: 2 })
  })
})
