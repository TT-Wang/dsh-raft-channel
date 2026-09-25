/**
 * Lifecycle edges of the persistent session: dispose while a wake is running
 * or queued, an external agent dispose, a session owned by another writer,
 * a POST still held by the debounce at dispose, and the SessionEnd flush.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WAKE_NOTICE } from '../src/index.js'
import type { RaftRuntime } from '../src/runtime.js'
import { needsRewake } from '../src/runtime.js'
import { FAKE_RAFT, fakeRaftRecords, holdRequest, host, mountChannel, postWake, raftCheck, scratch, until, wakeBody, type Host } from './harness.js'

const AGENT_ID = 'agent-1'

function noticeRequests(h: Host): number {
  return h.adapter.requests.filter(request => {
    const last = request.messages.filter(message => message.role === 'user').at(-1)
    return last?.content.some(block => block.type === 'text' && block.text === WAKE_NOTICE) === true
  }).length
}

function hold(h: Host): () => void {
  let release!: () => void
  h.adapter.gate = new Promise<void>(resolve => { release = resolve })
  return () => {
    h.adapter.gate = undefined
    release()
  }
}

describe('session lifecycle', () => {
  let home: string
  let root: string
  let log: string
  const hosts: Host[] = []

  beforeEach(() => {
    home = scratch('life')
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

  it('a wake answered 2xx before a dispose mid-turn is re-delivered after restart (no new wake needed)', async () => {
    const first = await boot()
    // Turn 1 has started its check, so wake 2 gets a notice of its own.
    first.h.adapter.queue.push(raftCheck('check-1'))
    const release = holdRequest(first.h, 2)
    expect((await postWake(first.url, first.token, wakeBody(1))).body.ok).toBe(true)
    await until(() => first.h.adapter.requests.length === 2, 5000, 'turn 1 in flight after its check')
    // Queued behind the running turn and acknowledged to the bridge.
    expect((await postWake(first.url, first.token, wakeBody(2))).body).toEqual({ ok: true, runtimeSession: 'raft-p-1' })
    expect(first.h.ctx.agents.get('raft-p-1' as never)!.inbox.nextTurn).toHaveLength(1)
    const disposing = first.h.ctx.fiber.dispose()
    release()
    await disposing
    hosts.splice(0)

    const second = await boot()
    expect(second.channel.status().runtimeSession).toBe('raft-p-1')
    await until(() => second.h.adapter.requests.length >= 1, 5000, 'recovery turn without a new wake')
    await second.h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    expect(noticeRequests(second.h)).toBe(1)
    expect(second.h.logs.some(line => line.text.includes('queued a fresh wake notice'))).toBe(true)
  })

  it('a clean previous run is resumed without an extra turn', async () => {
    const first = await boot()
    await postWake(first.url, first.token)
    await first.h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    await first.h.ctx.fiber.dispose()
    hosts.splice(0)
    const second = await boot()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(second.h.adapter.requests).toHaveLength(0)
  })

  it('re-attaches after an external dispose and re-delivers the canceled notice', async () => {
    const { h, channel, token, url } = await boot()
    const release = hold(h)
    await postWake(url, token, wakeBody(1))
    await until(() => h.adapter.requests.length === 1, 5000, 'turn 1 in flight')
    expect((await postWake(url, token, wakeBody(2))).body.ok).toBe(true)
    const runtime = (channel as unknown as { runtime: RaftRuntime }).runtime
    const handle = (runtime as unknown as { current: { handle: { dispose(): Promise<void> } } }).current.handle
    const disposing = handle.dispose()
    release()
    await disposing
    // Between the loss and the re-attach, wakes are refused retryably.
    const refused = await postWake(url, token, wakeBody(3))
    expect(refused).toMatchObject({ status: 503, body: { ok: false, failureClass: 'no_session' } })
    await until(() => h.logs.some(line => line.text.includes('re-attached raft-p-1')), 5000, 're-attach')
    await until(() => h.adapter.requests.length >= 2, 5000, 'recovery turn')
    await h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    expect(channel.status()).toMatchObject({ state: 'ready', runtimeSession: 'raft-p-1' })
    expect(noticeRequests(h)).toBe(2)
    expect((await postWake(url, token, wakeBody(4))).body).toEqual({ ok: true, runtimeSession: 'raft-p-1' })
  })

  it('refuses to start when another live writer owns the session', async () => {
    const first = await boot()
    await postWake(first.url, first.token)
    await first.h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    // Make the first writer's log durable, so the second finds it and its owner.
    await (first.h.ctx.get('sessionPersistence') as { flush(): Promise<void> }).flush()
    const spawns = fakeRaftRecords(log).length
    const other = await host({ persistenceRoot: root })
    hosts.push(other)
    const { channel } = await mountChannel(other, { profile: 'p', expectedAgentId: AGENT_ID, raftBin: FAKE_RAFT, debounceMs: 0 })
    expect(channel.status()).toMatchObject({ state: 'failed' })
    expect(channel.status().error).toMatch(/raft-p-1 is already owned by a live writer/)
    expect(channel.status().endpoint).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(fakeRaftRecords(log)).toHaveLength(spawns)
    // The first instance is untouched.
    expect((await postWake(first.url, first.token, wakeBody(2))).body).toEqual({ ok: true, runtimeSession: 'raft-p-1' })
  })

  it('answers a POST still held by the debounce with a retryable 503 at dispose', async () => {
    const { h, fiber, token, url } = await boot({ debounceMs: 60_000 })
    expect((await postWake(url, token, wakeBody(1))).body.ok).toBe(true)
    await h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    const held = postWake(url, token, wakeBody(2))
    await new Promise(resolve => setTimeout(resolve, 100))
    await fiber.dispose()
    expect(await held).toMatchObject({ status: 503, body: { ok: false, failureClass: 'no_session' } })
  })

  it('the debounce window runs on a monotonic clock: a wall-clock jump back does not stretch it', async () => {
    const { h, token, url } = await boot({ debounceMs: 300 })
    expect((await postWake(url, token, wakeBody(1))).body.ok).toBe(true)
    await h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    const real = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() - 20_000)
    try {
      const started = performance.now()
      const answer = await Promise.race([
        postWake(url, token, wakeBody(2)),
        new Promise<'held'>(resolve => { setTimeout(() => { resolve('held') }, 3000) }),
      ])
      expect(answer).toMatchObject({ status: 200, body: { ok: true, runtimeSession: 'raft-p-1' } })
      expect(performance.now() - started).toBeLessThan(2000)
    } finally {
      clock.mockRestore()
    }
  })

  it('flushes SessionEnd through one --once bridge pass at dispose', async () => {
    const { h, fiber, token, url } = await boot()
    await postWake(url, token)
    await h.ctx.agents.get('raft-p-1' as never)!.whenIdle()
    await fiber.dispose()
    const once = fakeRaftRecords(log).find(record => record.event === 'once')
    expect(once?.argv).toContain('--once')
    expect(once?.argv).toContain('--expected-agent')
    expect(once?.drained?.events.map(event => event.hookEventName)).toContain('SessionEnd')
    expect(once?.drained?.events.at(-1)).toMatchObject({ hookEventName: 'SessionEnd', sessionId: 'raft-p-1' })
  })
})

describe('needsRewake', () => {
  const at = (type: string, data: unknown) => ({ type, data }) as unknown as SessionEvent
  it('reads the latest turn outcome and canceled input', () => {
    expect(needsRewake([])).toBe(false)
    expect(needsRewake([at('turn/start', { turn: 1 })])).toBe(true)
    expect(needsRewake([at('turn/start', { turn: 1 }), at('turn/end', { turn: 1, reason: { kind: 'completed' } })])).toBe(false)
    expect(needsRewake([at('turn/start', { turn: 1 }), at('turn/end', { turn: 1, reason: { kind: 'interrupted' } })])).toBe(true)
    expect(needsRewake([at('turn/end', { turn: 1, reason: { kind: 'completed' } }), at('agent/inbox/spliced', { removedCount: 1, inserted: [], outcome: 'canceled' })])).toBe(true)
    expect(needsRewake([
      at('agent/inbox/spliced', { removedCount: 1, inserted: [], outcome: 'canceled' }),
      at('turn/start', { turn: 2 }),
      at('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])).toBe(false)
  })
})
