/**
 * Check-aware coalescing against a real DSH agent loop: a wake that arrives
 * while a notice-started turn has not yet started `raft message check` is
 * covered by that check; once the check has started (or in a turn a notice did
 * not start) a wake gets a notice of its own.
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WAKE_NOTICE, isRaftCheckCall, isRaftCheckCommand } from '../src/index.js'
import { FAKE_RAFT, fakeRaftRecords, holdRequest, host, mountChannel, postWake, raftCheck, scratch, text, until, wakeBody, type Host } from './harness.js'

const AGENT_ID = 'agent-1'
const SESSION = 'raft-test-profile-1'

describe('raft message check detection', () => {
  it.each([
    'raft message check',
    'RAFT_PROFILE=x raft message check',
    'SLOCK_PROFILE=x slock message check',
    'raft --profile x message check 2>&1 | head',
    'raft --profile=x message check --json',
    'cd /tmp && raft message check',
    'true; raft message check',
    '(raft message check)',
    "bash -c 'raft message check'",
    '/usr/local/bin/raft message check',
    'raft  message   check',
    'slock message check',
  ])('matches %j', command => {
    expect(isRaftCheckCommand(command)).toBe(true)
  })

  it.each([
    'raft message read --target dm:@x',
    'raft message send --target dm:@x',
    'raft message checkpoint',
    'raft messages check',
    'myraft message check',
    'raft task check',
    '',
  ])('does not match %j', command => {
    expect(isRaftCheckCommand(command)).toBe(false)
  })

  it('treats the words after whitespace as a check, even as an echo argument (a false match only disables the optimization)', () => {
    expect(isRaftCheckCommand('echo raft message check')).toBe(true)
  })

  it('reads any top-level string argument of a tool call, or the raw text when it is not a JSON object', () => {
    expect(isRaftCheckCall(JSON.stringify({ command: 'raft message check' }))).toBe(true)
    expect(isRaftCheckCall(JSON.stringify({ cmd: 'RAFT_PROFILE=x raft message check', timeout: 30 }))).toBe(true)
    expect(isRaftCheckCall(JSON.stringify({ command: 'raft message read --target x' }))).toBe(false)
    expect(isRaftCheckCall(JSON.stringify({ value: 42 }))).toBe(false)
    expect(isRaftCheckCall('raft message check')).toBe(true)
    expect(isRaftCheckCall('{not json raft message check')).toBe(true)
    expect(isRaftCheckCall(JSON.stringify(['raft message check']))).toBe(true)
  })
})

function notices(h: Host): string[] {
  const agent = h.ctx.agents.get(SESSION as never)!
  return (agent.session.snapshotEvents() as readonly SessionEvent[])
    .filter(event => event.type === 'user/message')
    .map(event => (event as SessionEvent<'user/message'>).data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('check-aware wake coalescing', () => {
  let h: Host
  let home: string
  let log: string

  beforeEach(async () => {
    home = scratch('coalesce')
    log = join(home, 'fake-raft.log')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('FAKE_RAFT_LOG', log)
    vi.stubEnv('FAKE_RAFT_SCENARIO', 'serve')
    vi.stubEnv('RAFT_PROFILE', undefined)
    vi.stubEnv('SLOCK_PROFILE', undefined)
    h = await host()
  })

  afterEach(async () => {
    await h.ctx.fiber.dispose()
    vi.unstubAllEnvs()
  })

  async function mount() {
    const { channel } = await mountChannel(h, { profile: 'test-profile', expectedAgentId: AGENT_ID, raftBin: FAKE_RAFT, debounceMs: 0 })
    await until(() => fakeRaftRecords(log).length > 0, 10_000, 'bridge spawn')
    return { token: fakeRaftRecords(log)[0]!.env.RAFT_CHANNEL_TOKEN!, url: channel.status().endpoint! }
  }

  const agent = () => h.ctx.agents.get(SESSION as never)!
  const debug = () => h.logs.filter(line => line.text.includes('raft-channel: wake #')).map(line => line.text)

  it('a wake before the notice-started turn runs its check is answered 200 without a second notice', async () => {
    const { token, url } = await mount()
    h.adapter.queue.push(raftCheck('check-1'), text('handled'))
    const release = holdRequest(h, 1)
    expect(await postWake(url, token, wakeBody(1))).toEqual({ status: 200, body: { ok: true, runtimeSession: SESSION } })
    await until(() => h.adapter.requests.length === 1, 5000, 'notice turn in flight, check not yet issued')
    // The bridge's reconciliation re-POSTs while the message is still pending server-side.
    expect(await postWake(url, token, wakeBody(1))).toEqual({ status: 200, body: { ok: true, runtimeSession: SESSION } })
    expect(agent().inbox.nextTurn).toHaveLength(0)
    release()
    await until(() => agent().status === 'idle' && h.adapter.requests.length >= 2, 5000, 'turn done')
    await agent().whenIdle()
    expect(notices(h)).toEqual([WAKE_NOTICE])
    expect(h.adapter.requests).toHaveLength(2)
    expect(debug()).toEqual([
      expect.stringMatching(/wake #1 injected$/),
      expect.stringMatching(/wake #2 coalesced: pre-check turn$/),
    ])
    // The turn has ended: the next wake gets its own notice again.
    expect((await postWake(url, token, wakeBody(2))).status).toBe(200)
    await until(() => h.adapter.requests.length === 3, 5000, 'third wake handled')
    await agent().whenIdle()
    expect(notices(h)).toEqual([WAKE_NOTICE, WAKE_NOTICE])
  })

  it('a wake after the check call started queues a second notice, which runs as the next turn', async () => {
    const { token, url } = await mount()
    h.adapter.queue.push(raftCheck('check-1', 'RAFT_PROFILE=test-profile raft message check 2>&1'), text('handled'))
    const release = holdRequest(h, 2)
    await postWake(url, token, wakeBody(1))
    await until(() => h.adapter.requests.length === 2, 5000, 'check ran, turn still in flight')
    expect(await postWake(url, token, wakeBody(2))).toEqual({ status: 200, body: { ok: true, runtimeSession: SESSION } })
    expect(agent().inbox.nextTurn.map(message => message.content)).toEqual([[{ type: 'text', text: WAKE_NOTICE }]])
    // A further wake is covered by that unclaimed notice.
    expect((await postWake(url, token, wakeBody(3))).status).toBe(200)
    release()
    await until(() => h.adapter.requests.length === 3 && agent().status === 'idle', 5000, 'second notice turn')
    await agent().whenIdle()
    expect(notices(h)).toEqual([WAKE_NOTICE, WAKE_NOTICE])
    const turnStarts = (agent().session.snapshotEvents() as readonly SessionEvent[]).filter(event => event.type === 'turn/start')
    expect(turnStarts).toHaveLength(2)
    expect(debug()).toEqual([
      expect.stringMatching(/wake #1 injected$/),
      expect.stringMatching(/wake #2 injected$/),
      expect.stringMatching(/wake #3 coalesced: unclaimed notice$/),
    ])
  })

  it('a wake during a turn that no notice started injects a notice', async () => {
    const { token, url } = await mount()
    const release = holdRequest(h, 1)
    agent().followup(createUserMessage({ content: [{ type: 'text', text: 'operator question' }], source: { kind: 'user' } }))
    await until(() => h.adapter.requests.length === 1, 5000, 'operator turn in flight')
    expect(await postWake(url, token, wakeBody(1))).toEqual({ status: 200, body: { ok: true, runtimeSession: SESSION } })
    expect(agent().inbox.nextTurn).toHaveLength(1)
    release()
    await until(() => h.adapter.requests.length === 2 && agent().status === 'idle', 5000, 'notice turn')
    await agent().whenIdle()
    expect(notices(h)).toEqual(['operator question', WAKE_NOTICE])
  })

  it('a notice-started turn that ends without a check stops covering wakes', async () => {
    const { token, url } = await mount()
    await postWake(url, token, wakeBody(1))
    await until(() => h.adapter.requests.length === 1 && agent().status === 'idle', 5000, 'turn without a check')
    await agent().whenIdle()
    await postWake(url, token, wakeBody(1))
    await until(() => h.adapter.requests.length === 2 && agent().status === 'idle', 5000, 'redelivered wake')
    await agent().whenIdle()
    expect(notices(h)).toEqual([WAKE_NOTICE, WAKE_NOTICE])
  })
})
