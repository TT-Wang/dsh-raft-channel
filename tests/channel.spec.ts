/** Contract pins 1-4 against a real DSH agent loop, with the fake raft bridge as the only other process. */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WAKE_NOTICE, orientationText } from '../src/index.js'
import { FAKE_RAFT, fakeRaftRecords, host, mountChannel, postWake, scratch, text, toolCall, until, wakeBody, type Host } from './harness.js'

const AGENT_ID = '00000000-0000-4000-8000-000000000001'
const SESSION = 'raft-test-profile-1'
const ACTIVITY_KEYS = new Set(['schema', 'eventId', 'sessionId', 'hookEventName', 'toolName', 'status', 'occurredAt', 'durationMs',
  'errorClass', 'toolInput', 'toolOutput', 'toolInputTruncated', 'toolOutputTruncated', 'truncated'])

function userMessages(h: Host): Array<{ text: string; kind: string; session: string }> {
  const out: Array<{ text: string; kind: string; session: string }> = []
  for (const agent of h.ctx.agents.list()) {
    for (const event of agent.session.snapshotEvents() as readonly SessionEvent[]) {
      if (event.type !== 'user/message') continue
      const message = (event as SessionEvent<'user/message'>).data
      out.push({ text: message.content.map(block => block.type === 'text' ? block.text : '').join(''), kind: message.source.kind, session: agent.session.id })
    }
  }
  return out
}

function gate(h: Host): () => void {
  let release!: () => void
  h.adapter.gate = new Promise<void>(resolve => { release = resolve })
  return () => {
    h.adapter.gate = undefined
    release()
  }
}

describe('wake endpoint against a real agent loop', () => {
  let h: Host
  let home: string
  let log: string

  beforeEach(async () => {
    home = scratch('home')
    log = join(home, 'fake-raft.log')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('FAKE_RAFT_LOG', log)
    vi.stubEnv('FAKE_RAFT_SCENARIO', 'serve')
    vi.stubEnv('RAFT_PROFILE', undefined)
    vi.stubEnv('SLOCK_PROFILE', undefined)
    vi.stubEnv('RAFT_EXPECTED_AGENT_ID', undefined)
    h = await host()
  })

  afterEach(async () => {
    await h.ctx.fiber.dispose()
    vi.unstubAllEnvs()
  })

  async function mount(extra: Record<string, unknown> = {}) {
    const { channel, fiber } = await mountChannel(h, { profile: 'test-profile', expectedAgentId: AGENT_ID, raftBin: FAKE_RAFT, ...extra })
    await until(() => fakeRaftRecords(log).length > 0, 10_000, 'bridge spawn')
    const token = fakeRaftRecords(log)[0]!.env.RAFT_CHANNEL_TOKEN!
    return { channel, fiber, token, url: channel.status().endpoint! }
  }

  it('pin 1: an accepted wake answers runtimeSession and runs a turn on the fixed kind-user notice', async () => {
    const { channel, token, url } = await mount({ debounceMs: 0 })
    expect(channel.status()).toMatchObject({ state: 'ready', runtimeSession: SESSION })
    const answer = await postWake(url, token)
    expect(answer).toEqual({ status: 200, body: { ok: true, runtimeSession: SESSION } })
    await h.ctx.agents.get(SESSION as never)!.whenIdle()
    expect(userMessages(h)).toEqual([{ text: WAKE_NOTICE, kind: 'user', session: SESSION }])
    expect(h.adapter.requests).toHaveLength(1)
    const system = h.adapter.requests[0]!.messages.find(message => message.role === 'system')!
    expect(system.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain(orientationText('test-profile'))
    const state = JSON.parse(readFileSync(join(home, 'raft-channel', 'test-profile.json'), 'utf8')) as Record<string, unknown>
    expect(state).toMatchObject({ schema: 'dsh-raft-channel-state.v1', profile: 'test-profile', index: 1, sessionId: SESSION })
    expect(h.errors).toEqual([])
  })

  it('pin 2: the token is enforced and content-shaped payloads are rejected before anything is injected', async () => {
    const { token, url } = await mount({ debounceMs: 0 })
    expect(await postWake(url, undefined)).toMatchObject({ status: 401, body: { ok: false, failureClass: 'auth_revoked' } })
    expect(await postWake(url, 'x'.repeat(token.length))).toMatchObject({ status: 401 })
    for (const field of ['text', 'content', 'message', 'messages', 'body', 'preview', 'snippet']) {
      const answer = await postWake(url, token, { ...wakeBody(), [field]: 'hello from a human' })
      expect(answer, field).toMatchObject({ status: 400, body: { ok: false, failureClass: 'protocol_mismatch' } })
    }
    expect(await postWake(url, token, { ...wakeBody(), schema: 'raft-channel-wake.v2' })).toMatchObject({ status: 400 })
    expect(await postWake(url, token, { ...wakeBody(), messageId: 'id\ninjected' })).toMatchObject({ status: 400 })
    const get = await fetch(url, { headers: { 'x-raft-bridge-token': token } })
    expect(get.status).toBe(405)
    expect(userMessages(h)).toEqual([])
    // A missing schema is tolerated, like the reference endpoint.
    const { schema: _schema, ...unversioned } = wakeBody()
    expect(await postWake(url, token, unversioned)).toMatchObject({ status: 200, body: { ok: true } })
  })

  it('pin 4: a burst of wakes while the agent is busy injects fewer notices, and every POST is answered', async () => {
    const release = gate(h)
    const { token, url } = await mount()
    const first = await postWake(url, token)
    expect(first.body.ok).toBe(true)
    await until(() => h.adapter.requests.length === 1, 5000, 'first turn in flight')
    const burst = await Promise.all(Array.from({ length: 12 }, (_, n) => postWake(url, token, wakeBody(n + 2))))
    for (const answer of burst) expect(answer).toEqual({ status: 200, body: { ok: true, runtimeSession: SESSION } })
    release()
    await until(() => h.ctx.agents.get(SESSION as never)!.status === 'idle' && h.adapter.requests.length >= 2, 5000, 'turns')
    await h.ctx.agents.get(SESSION as never)!.whenIdle()
    const notices = userMessages(h)
    expect(notices.length).toBeLessThan(13)
    expect(notices).toEqual([
      { text: WAKE_NOTICE, kind: 'user', session: SESSION },
      { text: WAKE_NOTICE, kind: 'user', session: SESSION },
    ])
  })

  it('pin 4 through the bridge child: its concurrent wakes are all answered 2xx and coalesced', async () => {
    vi.stubEnv('FAKE_RAFT_SCENARIO', 'wakes:6')
    const release = gate(h)
    await mount()
    await until(() => fakeRaftRecords(log).some(record => record.event === 'answers'), 10_000, 'bridge answers')
    const answers = fakeRaftRecords(log).find(record => record.event === 'answers')!.answers!
    expect(answers).toHaveLength(6)
    for (const answer of answers) expect(answer).toEqual({ status: 200, body: { ok: true, runtimeSession: SESSION } })
    release()
    await until(() => h.adapter.requests.length >= 1 && h.ctx.agents.get(SESSION as never)!.status === 'idle', 5000, 'idle')
    await h.ctx.agents.get(SESSION as never)!.whenIdle()
    expect(userMessages(h).length).toBeGreaterThanOrEqual(1)
    expect(userMessages(h).length).toBeLessThan(6)
  })

  it('spawns the bridge with --expected-agent and --runtime-session; the token travels only in env', async () => {
    const { token, url } = await mount({ bridge: { pollIntervalMs: 2500 } })
    const [record] = fakeRaftRecords(log)
    expect(record!.argv).toEqual([
      'agent', 'bridge', '--json', '--wake-adapter', 'wake-channel', '--wake-channel-endpoint', url,
      '--runtime-session', SESSION, '--expected-agent', AGENT_ID, '--poll-interval-ms', '2500',
    ])
    expect(record!.env).toEqual({ RAFT_PROFILE: 'test-profile', SLOCK_PROFILE: 'test-profile', RAFT_CHANNEL_TOKEN: token, RAFT_EXPECTED_AGENT_ID: AGENT_ID })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(record!.argv.join(' ')).not.toContain(token)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/wake$/)
  })

  it('serves raft-activity.v1 drains built from turn and tool events, never assistant text', async () => {
    const { token, url } = await mount({ debounceMs: 0 })
    h.adapter.queue.push(toolCall('call-1', 'echo', { value: 'hi' }), text('assistant secret words'))
    await postWake(url, token)
    await h.ctx.agents.get(SESSION as never)!.whenIdle()
    const drainUrl = url.replace(/\/wake$/, '/activity/drain?max=50')
    expect((await fetch(drainUrl)).status).toBe(401)
    const drained = await (await fetch(drainUrl, { headers: { 'x-raft-bridge-token': token } })).json() as { schema: string; dropped: number; events: Array<Record<string, unknown>> }
    expect(drained.schema).toBe('raft-activity-drain.v1')
    expect(drained.dropped).toBe(0)
    expect(drained.events.map(event => [event.hookEventName, event.status, event.toolName])).toEqual([
      ['SessionStart', 'started', undefined],
      ['UserPromptSubmit', 'started', undefined],
      ['PreToolUse', 'started', 'echo'],
      ['PostToolUse', 'succeeded', 'echo'],
      ['Stop', 'completed', undefined],
    ])
    const pre = drained.events[2]!
    const post = drained.events[3]!
    expect(pre).toMatchObject({ schema: 'raft-activity.v1', sessionId: SESSION, toolInput: '{"value":"hi"}', toolInputTruncated: false })
    expect(post).toMatchObject({ toolOutput: 'echo:hi', toolOutputTruncated: false })
    expect(typeof post.durationMs).toBe('number')
    for (const event of drained.events) for (const key of Object.keys(event)) expect(ACTIVITY_KEYS.has(key), key).toBe(true)
    expect(JSON.stringify(drained)).not.toContain('assistant secret words')
    expect(JSON.stringify(drained)).not.toContain(token)
    const again = await (await fetch(drainUrl, { headers: { 'x-raft-bridge-token': token } })).json() as { events: unknown[] }
    expect(again.events).toEqual([])
  })

  it('dispose kills the bridge child, closes the endpoint and never writes stdout', async () => {
    const write = vi.spyOn(process.stdout, 'write')
    const { fiber, token, url } = await mount({ debounceMs: 0 })
    await postWake(url, token)
    await h.ctx.agents.get(SESSION as never)!.whenIdle()
    const pid = fakeRaftRecords(log)[0]!.pid
    await fiber.dispose()
    expect(fakeRaftRecords(log).some(record => record.event === 'sigterm' && record.pid === pid)).toBe(true)
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
    expect(h.ctx.agents.get(SESSION as never)).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
  })

  it('fails fast without an expected Agent id and never spawns the bridge', async () => {
    await expect(h.ctx.plugin((await import('../src/index.js')).default, { profile: 'test-profile', raftBin: FAKE_RAFT }))
      .rejects.toThrow(/RAFT_EXPECTED_AGENT_ID/)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(fakeRaftRecords(log)).toEqual([])
    expect(h.ctx.agents.list()).toEqual([])
  })
})
