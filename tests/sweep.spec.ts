/**
 * The mention sweep: parsing of the real CLI 0.0.26 output, the notice, and
 * the sweep against a real DSH agent loop with the fake raft CLI printing
 * canned `profile show --json` / `message search` output.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MENTIONS_SCHEMA,
  MentionSweeper,
  checkShortIds,
  mentionNotice,
  mentionsHandle,
  orientationText,
  parseProfile,
  parseSearchOutput,
  parseSearchTime,
  sourceTarget,
  WAKE_NOTICE,
  type Mention,
} from '../src/index.js'
import { FAKE_RAFT, holdRequest, host, mountChannel, scratch, text, toolCall, until, type Host } from './harness.js'

const REAL_SEARCH = readFileSync(new URL('./fixtures/search-real.txt', import.meta.url), 'utf8')
const PROFILE = 'test-profile'
const SESSION = 'raft-test-profile-1'
const MINUTE = 60_000

describe('search output parsing (captured from CLI 0.0.26)', () => {
  it('parses every result block of a real `raft message search --query "@slicey-dsh"`', () => {
    const results = parseSearchOutput(REAL_SEARCH)
    expect(results.map(result => [result.id.slice(0, 8), result.source, result.sender, result.senderType])).toEqual([
      ['d1978647', 'dm:slicey-dsh', 'slicey-dsh', 'agent'],
      ['d3b479f3', 'thread:all:0ffb9edf', 'slice-eval-3', 'agent'],
      ['0ffb9edf', 'channel:all', 'slice-eval-3', 'agent'],
      ['2e3a891a', 'channel:all', 'slice-eval-3', 'agent'],
      ['64446c8c', 'thread:all:58bcd78c', 'slice-eval-3', 'agent'],
      ['58bcd78c', 'channel:all', 'slice-eval-3', 'agent'],
      ['1d439385', 'dm:slicey-dsh', 'slicey-dsh', 'agent'],
    ])
    expect(results[1]!.id).toBe('d3b479f3-5698-49f7-bd6b-9e140c1fdfdb')
    expect(results[1]!.time).toBe(Date.parse('2026-09-25T13:01:14Z'))
    expect(results[1]!.preview).toBe('<match>user:slicey-dsh</match> final acceptance 2 (test, please ignore): reply in this thread with the word THREAD-OK-2.')
    expect(parseSearchOutput('No search results.\n')).toEqual([])
  })

  it('reads the local time with offset the CLI prints', () => {
    expect(parseSearchTime('2026-09-25 20:56:12 +08:00')).toBe(Date.parse('2026-09-25T12:56:12Z'))
    expect(parseSearchTime('2026-09-25 01:00:00 -05:30')).toBe(Date.parse('2026-09-25T06:30:00Z'))
    expect(parseSearchTime('-')).toBeNaN()
  })

  it('maps channel and channel-thread sources to reply targets, and refuses DM sources', () => {
    expect(sourceTarget('channel:研发')).toBe('#研发')
    expect(sourceTarget('thread:研发:0ffb9edf')).toBe('#研发:0ffb9edf')
    expect(sourceTarget('channel:all')).toBe('#all')
    expect(sourceTarget('thread:all:0ffb9edf')).toBe('#all:0ffb9edf')
    expect(sourceTarget('dm:slicey-dsh')).toBeUndefined()
    expect(sourceTarget('dm:richard:55555555')).toBeUndefined()
    expect(sourceTarget('')).toBeUndefined()
  })

  it('confirms an @mention in the preview; full-text hits on the bare words are not mentions', () => {
    const [own, thread] = parseSearchOutput(REAL_SEARCH)
    expect(mentionsHandle(own!.preview, 'slicey-dsh')).toBe(false)
    expect(mentionsHandle(thread!.preview, 'slicey-dsh')).toBe(true)
    expect(mentionsHandle('hi,@slicey-dsh see this', 'slicey-dsh')).toBe(true)
    expect(mentionsHandle('ping user:slicey-dsh-2', 'slicey-dsh')).toBe(false)
    expect(mentionsHandle('open dm:user:slicey-dsh', 'slicey-dsh')).toBe(false)
    // The CLI rewrites only ASCII `@name`; a Unicode handle stays `@name`.
    expect(mentionsHandle('<match>@小助手</match> 看一下', '小助手')).toBe(true)
    expect(mentionsHandle('@小助手二号 看一下', '小助手')).toBe(false)
  })

  it('reads the handle from `raft profile show --json`', () => {
    const json = JSON.stringify({ ok: true, data: { kind: 'agent', id: '00000000', isSelf: true, name: 'slicey-dsh', displayName: 'Slicey', description: null } })
    expect(parseProfile(json)).toEqual({ handle: 'slicey-dsh', displayName: 'Slicey' })
    expect(parseProfile(JSON.stringify({ ok: true, data: { name: '小助手', displayName: '' } }))).toEqual({ handle: '小助手', displayName: '小助手' })
    expect(() => parseProfile(JSON.stringify({ ok: false }))).toThrow(/usable handle/)
  })

  it('collects the short ids a `raft message check` output delivered', () => {
    const check = [
      '[target=#all msg=0ffb9edf time=2026-09-25 12:56:12Z type=agent] @slice-eval-3: @slicey-dsh final acceptance 1',
      '[target=#all:0ffb9edf msg=d3b479f3 time=2026-09-25 13:01:14Z type=agent] @slice-eval-3 — eval agent: reply here',
      '[target=dm:@tongtao-wang msg=1d439385 time=2026-09-25 10:52:35Z type=human] @tongtao-wang: ping',
    ].join('\n')
    expect(checkShortIds(check)).toEqual(['0ffb9edf', 'd3b479f3', '1d439385'])
    expect(checkShortIds('No new inbox messages.')).toEqual([])
  })
})

describe('mention notice and orientation', () => {
  it('names one mention by target and short id with a quoted read command', () => {
    expect(mentionNotice([{ target: '#all', shortId: '0ffb9edf' }], 'slicey-dsh')).toBe(
      '[Raft mention] You were mentioned and it may not appear in raft message check: #all message 0ffb9edf. '
      + 'Read it with `raft message read --target "#all" --around 0ffb9edf` and answer in that target if it still needs an answer.')
  })

  it('lists up to five mentions, then counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ target: i % 2 === 0 ? '#all' : '#all:0ffb9edf', shortId: `0000000${i}` }))
    const notice = mentionNotice(many, 'slicey-dsh')
    expect(notice).toBe('[Raft mention] You were mentioned and it may not appear in raft message check: '
      + '#all message 00000000; #all:0ffb9edf message 00000001; #all message 00000002; #all:0ffb9edf message 00000003; #all message 00000004; '
      + '+2 more (find them with `raft message search --query "@slicey-dsh" --sort recent`). '
      + 'Read each with `raft message read --target "<target>" --around <shortid>` and answer in its target if it still needs an answer.')
  })

  it('orientation: answer what check returned or a mention notice names; read before replying stays', () => {
    const text = orientationText('p')
    expect(text).toContain('Answer messages that check returned or that a "[Raft mention]" notice names; use read and `raft message search` for context.')
    expect(text).not.toContain('Answer only messages that check returned')
    expect(text).toContain('2. Before replying in a target, run `raft message read --target <target>`.')
    expect(text).toContain('if the read shows you already replied after a message, do not answer it again.')
    expect(orientationText('p')).toBe(text)
    expect(orientationText('q').replaceAll('Raft profile q;', 'Raft profile p;')).toBe(text)
  })

  it('orientation: an empty first check ends a wake turn only when no mention notice came with it', () => {
    const text = orientationText('p')
    // A #all mention can reach the wake hint but not check (another replica's
    // memory): wake + mention in one turn must still handle the mention.
    expect(text).toContain('If the first check already prints that, the wake was handled earlier: end the turn without running anything else, unless a "[Raft mention]" notice came with it.')
    expect(text).toContain('On each "[Raft mention]" notice, with or without a wake: it names messages that check may never return. Read each one with the command it gives, then follow rules 2 to 4 for each that still needs an answer.')
  })
})

interface FakeResult {
  id: string
  channelType: 'channel' | 'thread' | 'dm'
  channelName: string
  parentChannelType?: string
  parentChannelName?: string
  senderName: string
  senderType: string
  content: string
  createdAt: string
}

function uuid(prefix: string): string {
  return `${prefix}-1111-4222-8333-444455556666`
}

function inAll(prefix: string, ageMs: number, content = `@${PROFILE} please look at this`, sender = 'alice'): FakeResult {
  return { id: uuid(prefix), channelType: 'channel', channelName: 'all', senderName: sender, senderType: 'human', content, createdAt: new Date(Date.now() - ageMs).toISOString() }
}

function userTexts(h: Host, session = SESSION): string[] {
  const agent = h.ctx.agents.get(session as never)
  if (agent === undefined) return []
  return (agent.session.snapshotEvents() as readonly SessionEvent[])
    .filter(event => event.type === 'user/message')
    .map(event => (event as SessionEvent<'user/message'>).data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

const mentionTexts = (h: Host, session = SESSION) => userTexts(h, session).filter(value => value.startsWith('[Raft mention]'))

describe('mention sweep against a real agent loop', () => {
  let h: Host
  let home: string
  let spec: string
  let sweepLog: string

  beforeEach(async () => {
    home = scratch('sweep')
    spec = join(home, 'sweep.json')
    sweepLog = join(home, 'sweep.log')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('FAKE_RAFT_SWEEP', spec)
    vi.stubEnv('FAKE_RAFT_SWEEP_LOG', sweepLog)
    vi.stubEnv('FAKE_RAFT_LOG', join(home, 'fake-raft.log'))
    vi.stubEnv('RAFT_PROFILE', undefined)
    vi.stubEnv('SLOCK_PROFILE', undefined)
    setSpec({ results: [] })
    h = await host()
  })

  afterEach(async () => {
    await h.ctx.fiber.dispose()
    vi.unstubAllEnvs()
  })

  function setSpec(value: { results?: FakeResult[]; search?: string; profile?: unknown }): void {
    writeFileSync(spec, JSON.stringify(value))
  }

  function sweepCalls(): Array<{ argv: string[]; env: Record<string, string | undefined> }> {
    if (!existsSync(sweepLog)) return []
    return readFileSync(sweepLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; env: Record<string, string | undefined> })
  }

  /** Mount with the bridge off (the sweep does not need it); the startup sweep finds nothing. */
  async function mount(extra: Record<string, unknown> = {}) {
    const { channel } = await mountChannel(h, { profile: PROFILE, raftBin: FAKE_RAFT, bridge: { enabled: false }, ...extra })
    expect(await channel.sweepMentions()).toMatchObject({ ok: true, notified: 0 })
    return channel
  }

  const agent = () => h.ctx.agents.get(SESSION as never)!

  it('a new #all mention gets one notice naming its target and short id; the same mention again gets none', async () => {
    const channel = await mount()
    const started = Date.now()
    setSpec({ results: [inAll('aaaa1111', 2 * MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([
      '[Raft mention] You were mentioned and it may not appear in raft message check: #all message aaaa1111. '
      + 'Read it with `raft message read --target "#all" --around aaaa1111` and answer in that target if it still needs an answer.',
    ])
    const claimed = agent().session.snapshotEvents().filter(event => event.type === 'user/message') as readonly SessionEvent<'user/message'>[]
    expect(claimed.at(-1)!.data.source.kind).toBe('user')
    // No content reaches the model: the notice names only target and id.
    expect(mentionTexts(h).join('')).not.toContain('please look at this')

    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 0 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toHaveLength(1)

    const search = sweepCalls().filter(call => call.argv[1] === 'search').at(-1)!
    expect(search.argv.slice(0, 6)).toEqual(['message', 'search', '--query', `@${PROFILE}`, '--sort', 'recent'])
    expect(search.argv).toContain('--limit')
    expect(search.env).toEqual({ RAFT_PROFILE: PROFILE, SLOCK_PROFILE: PROFILE })
    expect(sweepCalls().filter(call => call.argv[0] === 'profile')).toHaveLength(1)
    expect(sweepCalls().map(call => call.argv.slice(0, 2).join(' '))).not.toContain('message read')
    // First run: --after is plugin start minus the 15-minute lookback.
    const firstSearch = sweepCalls().find(call => call.argv[1] === 'search')!
    const after = Date.parse(firstSearch.argv[firstSearch.argv.indexOf('--after') + 1]!)
    expect(after).toBeGreaterThan(started - 16 * MINUTE)
    expect(after).toBeLessThanOrEqual(started - 15 * MINUTE + 1000)
    expect(channel.status().mentionSweep!.runs).toBeGreaterThanOrEqual(3)
    expect(h.errors).toEqual([])
  })

  it('threads map to their thread target; own messages, DMs and bare-word hits are ignored', async () => {
    const channel = await mount()
    setSpec({
      results: [
        { ...inAll('bbbb0001', MINUTE), channelType: 'thread', channelName: 'thread-0ffb9edf', parentChannelType: 'channel', parentChannelName: 'all' },
        { ...inAll('bbbb0003', MINUTE), senderType: 'agent', senderName: PROFILE },
        { ...inAll('bbbb0004', MINUTE), channelType: 'dm', channelName: 'alice' },
        inAll('bbbb0005', MINUTE, `the ${PROFILE} bot is great`),
      ],
    })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining(': #all:0ffb9edf message bbbb0001. Read it with `raft message read --target "#all:0ffb9edf" --around bbbb0001`')])
  })

  it('respects the lookback on the first run', async () => {
    const channel = await mount({ sweep: { lookbackMs: 10 * MINUTE } })
    setSpec({ results: [inAll('cccc0001', 11 * MINUTE), inAll('cccc0002', 9 * MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining('#all message cccc0002.')])
  })

  it('a mention a `raft message check` tool result already returned is not swept again', async () => {
    const channel = await mount()
    const mention = inAll('dddd0001', MINUTE)
    h.ctx.tools.register(defineTool({
      name: 'raftsh',
      description: 'fixture shell printing canned check output',
      parameters: { command: { type: 'string', required: true, description: 'command' } },
      output: { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
      execute: async () => `[target=#all msg=dddd0001 time=2026-09-25 12:56:12Z type=human] @alice: @${PROFILE} please look at this`,
    }))
    h.adapter.queue.push(toolCall('check-1', 'raftsh', { command: 'raft message check' }), text('answered'))
    agent().followup(createUserMessage({ content: [{ type: 'text', text: WAKE_NOTICE }], source: { kind: 'user' } }))
    await until(() => h.adapter.requests.length === 2, 5000, 'check turn')
    await agent().whenIdle()
    setSpec({ results: [mention, inAll('dddd0002', MINUTE)] })
    await until(() => existsSync(join(home, 'raft-channel', `${PROFILE}-mentions.json`))
      && readFileSync(join(home, 'raft-channel', `${PROFILE}-mentions.json`), 'utf8').includes('dddd0001'), 5000, 'checked id persisted')
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining('#all message dddd0002.')])
  })

  it('a CLI failure queues nothing and the next sweep retries', async () => {
    const channel = await mount()
    setSpec({ search: 'fail', results: [inAll('eeee0001', MINUTE)] })
    const failed = await channel.sweepMentions()
    expect(failed).toMatchObject({ ok: false, notified: 0 })
    expect(failed.error).toMatch(/raft message search exited code=1 signal=null: Error: Search is temporarily unavailable Code: SEARCH_UNAVAILABLE/)
    expect(channel.status().mentionSweep?.lastError).toMatch(/SEARCH_UNAVAILABLE|temporarily unavailable/)
    expect(mentionTexts(h)).toEqual([])
    expect(h.logs.some(line => line.type === 'warn' && line.text.includes('mention sweep failed'))).toBe(true)
    setSpec({ results: [inAll('eeee0001', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toHaveLength(1)
    expect(channel.status().mentionSweep?.lastError).toBeUndefined()
  })

  it('an unreadable profile is retried like any CLI failure', async () => {
    setSpec({ profile: 'fail' })
    const { channel } = await mountChannel(h, { profile: PROFILE, raftBin: FAKE_RAFT, bridge: { enabled: false } })
    expect(await channel.sweepMentions()).toMatchObject({ ok: false, error: expect.stringMatching(/raft profile show exited code=1/) })
    setSpec({ results: [inAll('ffff0001', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
  })

  it('sweeps while a notice waits merge into one notice instead of stacking', async () => {
    const channel = await mount()
    const release = holdRequest(h, 1)
    agent().followup(createUserMessage({ content: [{ type: 'text', text: 'operator question' }], source: { kind: 'user' } }))
    await until(() => h.adapter.requests.length === 1, 5000, 'operator turn in flight')
    setSpec({ results: [inAll('abab0001', 2 * MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    setSpec({ results: [inAll('abab0001', 2 * MINUTE), inAll('abab0002', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    expect(agent().inbox.nextTurn).toHaveLength(1)
    release()
    await until(() => h.adapter.requests.length === 2, 5000, 'mention turn')
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining(': #all message abab0001; #all message abab0002. Read each with')])
  })

  it('a mention notice canceled by an external dispose is queued again on re-attach', async () => {
    await h.ctx.fiber.dispose()
    h = await host({ persistenceRoot: join(home, 'sessions') })
    const channel = await mount()
    let release!: () => void
    h.adapter.gate = new Promise<void>(resolve => { release = resolve })
    agent().followup(createUserMessage({ content: [{ type: 'text', text: 'operator question' }], source: { kind: 'user' } }))
    await until(() => h.adapter.requests.length === 1, 5000, 'operator turn in flight')
    setSpec({ results: [inAll('dead0001', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    expect(agent().inbox.nextTurn).toHaveLength(1)
    const runtime = (channel as unknown as { runtime: { current: { handle: { dispose(): Promise<void> } } } }).runtime
    const disposing = runtime.current.handle.dispose()
    h.adapter.gate = undefined
    release()
    await disposing
    await until(() => h.logs.some(line => line.text.includes(`re-attached ${SESSION}`)), 5000, 're-attach')
    await until(() => mentionTexts(h).length === 1 && agent().status === 'idle', 5000, 're-queued mention notice')
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining('#all message dead0001.')])
  })

  it('a mention notice queued while the rotating turn runs is delivered once, in one of the two sessions', async () => {
    const channel = await mount({ rotate: { maxTurns: 1 } })
    const texts: string[] = []
    h.ctx.on('agent/inbox/claimed', ({ message }) => {
      for (const block of message.content) if (block.type === 'text' && block.text.startsWith('[Raft mention]')) texts.push(block.text)
    })
    const release = holdRequest(h, 1)
    agent().followup(createUserMessage({ content: [{ type: 'text', text: 'operator question' }], source: { kind: 'user' } }))
    await until(() => h.adapter.requests.length === 1, 5000, 'operator turn in flight')
    setSpec({ results: [inAll('0707e001', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    release()
    await until(() => channel.status().runtimeSession === 'raft-test-profile-2', 5000, 'rotation')
    await until(() => texts.length === 1 && h.adapter.requests.length === 2, 5000, 'mention notice handled')
    await h.ctx.agents.get('raft-test-profile-2' as never)?.whenIdle()
    expect(texts).toEqual([expect.stringContaining('#all message 0707e001.')])
  })

  it('persists the seen-set and watermark across a plugin restart', async () => {
    const channel = await mount()
    setSpec({ results: [inAll('abcd0001', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    await h.ctx.fiber.dispose()
    const file = join(home, 'raft-channel', `${PROFILE}-mentions.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; profile: string; watermark: string; seen: Array<{ id: string }> }
    expect(saved).toMatchObject({ schema: MENTIONS_SCHEMA, profile: PROFILE })
    expect(saved.seen.map(entry => entry.id)).toContain(uuid('abcd0001'))
    expect(Date.parse(saved.watermark)).toBeGreaterThan(Date.now() - 2 * MINUTE)

    h = await host()
    const { channel: again } = await mountChannel(h, { profile: PROFILE, raftBin: FAKE_RAFT, bridge: { enabled: false } })
    expect(await again.sweepMentions()).toMatchObject({ ok: true, notified: 0 })
    // The watermark narrows the next window: --after sits a minute before the newest handled mention.
    const lastSearch = sweepCalls().filter(call => call.argv[1] === 'search').at(-1)!
    expect(Date.parse(lastSearch.argv[lastSearch.argv.indexOf('--after') + 1]!)).toBe(Date.parse(saved.watermark) - MINUTE)
    const session = again.status().runtimeSession!
    await h.ctx.agents.get(session as never)!.whenIdle()
    expect(mentionTexts(h, session)).toEqual([])
  })

  it('searches only the configured targets', async () => {
    const channel = await mount({ sweep: { targets: ['#dev', '#all:0ffb9edf'] } })
    setSpec({ results: [inAll('aced0001', MINUTE), { ...inAll('aced0002', MINUTE), channelName: 'dev' }] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining('#dev message aced0002.')])
    const targets = sweepCalls().filter(call => call.argv[1] === 'search').map(call => call.argv[call.argv.indexOf('--target') + 1])
    expect(targets.slice(-2)).toEqual(['#dev', '#all:0ffb9edf'])
  })

  it('holds a new mention back while a wake notice waits unclaimed, then reports it once check work is done', async () => {
    const channel = await mount()
    const runtime = (channel as unknown as { runtime: { wake(): Promise<{ ok: boolean }> } }).runtime
    const release = holdRequest(h, 1)
    agent().followup(createUserMessage({ content: [{ type: 'text', text: 'operator question' }], source: { kind: 'user' } }))
    await until(() => h.adapter.requests.length === 1, 5000, 'operator turn in flight')
    expect(await runtime.wake()).toMatchObject({ ok: true })
    setSpec({ results: [inAll('defe0001', MINUTE)] })
    // The wake's check may deliver this mention: no notice yet, nothing marked seen.
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 0, deferred: 1 })
    expect(agent().inbox.nextTurn.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))).toEqual([WAKE_NOTICE])
    release()
    await until(() => h.adapter.requests.length === 2, 5000, 'wake turn')
    await agent().whenIdle()
    // The wake turn ended without check returning it (the #all case): now it is reported.
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining('#all message defe0001.')])
  })

  it('leaves mentions younger than the grace period for a later sweep', async () => {
    const channel = await mount()
    setSpec({ results: [inAll('0e0e0001', 5_000)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 0 })
    expect(channel.status().mentionSweep!.seen).toBe(0)
    // Not past the watermark either: a later sweep still finds it.
    setSpec({ results: [inAll('0e0e0001', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
  })

  it('a mention notice unclaimed at shutdown is queued again after a restart', async () => {
    await h.ctx.fiber.dispose()
    h = await host({ persistenceRoot: join(home, 'sessions') })
    const channel = await mount()
    let release!: () => void
    h.adapter.gate = new Promise<void>(resolve => { release = resolve })
    const live = agent()
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'operator question' }], source: { kind: 'user' } }))
    await until(() => h.adapter.requests.length === 1, 5000, 'operator turn in flight')
    setSpec({ results: [inAll('1ef70001', MINUTE)] })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    expect(channel.status().mentionSweep!.unclaimed).toBe(1)
    // Stop the plugin with the notice still queued: the dispose cancels it.
    const disposing = h.ctx.fiber.dispose()
    await until(() => {
      try {
        return live.inbox.nextTurn.length === 0
      } catch {
        return true // already disposed
      }
    }, 5000, 'queued notice canceled')
    h.adapter.gate = undefined
    release()
    await disposing
    const file = join(home, 'raft-channel', `${PROFILE}-mentions.json`)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { unclaimed: Array<{ shortId: string }> }).unclaimed.map(entry => entry.shortId)).toEqual(['1ef70001'])

    setSpec({ results: [] })
    h = await host({ persistenceRoot: join(home, 'sessions') })
    const { channel: again } = await mountChannel(h, { profile: PROFILE, raftBin: FAKE_RAFT, bridge: { enabled: false } })
    await until(() => mentionTexts(h, again.status().runtimeSession).length === 1, 5000, 're-queued mention notice')
    const session = again.status().runtimeSession!
    await h.ctx.agents.get(session as never)!.whenIdle()
    expect(mentionTexts(h, session)).toEqual([expect.stringContaining('#all message 1ef70001.')])
    await until(() => again.status().mentionSweep!.unclaimed === 0, 5000, 'claim recorded')
    expect(await again.sweepMentions()).toMatchObject({ ok: true, notified: 0 })
  })

  it('reports mentions in channels with Unicode names, and warns about a source it cannot map', async () => {
    const channel = await mount()
    setSpec({
      results: [
        { ...inAll('7e570001', MINUTE), channelName: '研发' },
        { ...inAll('7e570002', MINUTE), channelName: 'odd name' },
      ],
    })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 1 })
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining(': #研发 message 7e570001. Read it with `raft message read --target "#研发" --around 7e570001`')])
    expect(h.logs.filter(line => line.type === 'warn' && line.text.includes('cannot map source "channel:odd name" of message 7e570002'))).toHaveLength(1)
  })

  it('pages past a full first page instead of skipping older mentions', async () => {
    const channel = await mount()
    const many = Array.from({ length: 60 }, (_, i) => inAll(`pa9e${String(i).padStart(4, '0')}`, 2 * MINUTE + i * 1000))
    setSpec({ results: many })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 60 })
    const searches = sweepCalls().filter(call => call.argv[1] === 'search')
    expect(searches.at(-2)!.argv).not.toContain('--offset')
    expect(searches.at(-1)!.argv.slice(-2)).toEqual(['--offset', '50'])
    expect(h.logs.some(line => line.text.includes('full pages'))).toBe(false)
    await agent().whenIdle()
    expect(mentionTexts(h)).toEqual([expect.stringContaining('+55 more')])
  })

  it('a first page filled by the server\'s any-term fallback ends paging without a warning', async () => {
    const channel = await mount()
    // No message has both words of "@test-profile": the server returns any-term hits on page one only.
    setSpec({ results: Array.from({ length: 50 }, (_, i) => inAll(`a11e${String(i).padStart(4, '0')}`, 2 * MINUTE + i * 1000, 'the profile page changed')) })
    expect(await channel.sweepMentions()).toEqual({ ok: true, notified: 0 })
    const searches = sweepCalls().filter(call => call.argv[1] === 'search')
    expect(searches.at(-1)!.argv.slice(-2)).toEqual(['--offset', '50'])
    expect(h.logs.some(line => line.type === 'warn' && line.text.includes('mention sweep'))).toBe(false)
  })

  it('is off with sweep.enabled false', async () => {
    const { channel } = await mountChannel(h, { profile: PROFILE, raftBin: FAKE_RAFT, bridge: { enabled: false }, sweep: { enabled: false } })
    expect(await channel.sweepMentions()).toEqual({ ok: false, notified: 0, error: 'disabled' })
    expect(sweepCalls()).toEqual([])
    expect(channel.status().mentionSweep).toBeUndefined()
  })
})

describe('MentionSweeper', () => {
  it('times a hung CLI call out, never runs two sweeps at once, and retries', async () => {
    const home = scratch('sweeper')
    const spec = join(home, 'sweep.json')
    writeFileSync(spec, JSON.stringify({ search: 'hang' }))
    const logs: string[] = []
    const logger = { debug() {}, info() {}, warn: (...args: unknown[]) => { logs.push(args.join(' ')) }, error: (...args: unknown[]) => { logs.push(args.join(' ')) } }
    const notified: Mention[][] = []
    const sweeper = new MentionSweeper({
      command: FAKE_RAFT,
      profile: PROFILE,
      file: join(home, 'mentions.json'),
      intervalMs: 60_000,
      lookbackMs: 15 * MINUTE,
      targets: undefined,
      logger,
      notify: async mentions => { notified.push(mentions); return true },
      env: { ...process.env, FAKE_RAFT_SWEEP: spec },
      timeoutMs: 300,
    })
    const first = sweeper.sweep()
    expect(sweeper.sweep()).toBe(first)
    expect(await first).toMatchObject({ ok: false, error: expect.stringMatching(/timed out after 300ms/) })
    expect(notified).toEqual([])
    writeFileSync(spec, JSON.stringify({ results: [inAll('0a0a0001', MINUTE)] }))
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 1 })
    expect(notified[0]!.map(mention => [mention.target, mention.shortId])).toEqual([['#all', '0a0a0001']])
    await sweeper.stop()
    expect(logs.some(line => line.includes('timed out'))).toBe(true)
  })

  it('a refused notice is retried by the next sweep', async () => {
    const home = scratch('sweeper')
    const spec = join(home, 'sweep.json')
    writeFileSync(spec, JSON.stringify({ results: [inAll('0b0b0001', MINUTE)] }))
    let accept = false
    const calls: number[] = []
    const sweeper = new MentionSweeper({
      command: FAKE_RAFT,
      profile: PROFILE,
      file: join(home, 'mentions.json'),
      intervalMs: 60_000,
      lookbackMs: 15 * MINUTE,
      targets: undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      notify: async mentions => { calls.push(mentions.length); return accept },
      env: { ...process.env, FAKE_RAFT_SWEEP: spec },
    })
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 0 })
    accept = true
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 1 })
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 0 })
    expect(calls).toEqual([1, 1])
    await sweeper.stop()
  })

  function sweeperFor(home: string, spec: string, extra: Partial<ConstructorParameters<typeof MentionSweeper>[0]> = {}) {
    const logs: string[] = []
    const notified: Mention[][] = []
    const sweeper = new MentionSweeper({
      command: FAKE_RAFT,
      profile: PROFILE,
      file: join(home, 'mentions.json'),
      intervalMs: 60_000,
      lookbackMs: 15 * MINUTE,
      targets: undefined,
      logger: { debug() {}, info() {}, warn: (...args: unknown[]) => { logs.push(args.join(' ')) }, error: (...args: unknown[]) => { logs.push(args.join(' ')) } },
      notify: async mentions => { notified.push(mentions); return true },
      env: { ...process.env, FAKE_RAFT_SWEEP: spec },
      ...extra,
    })
    return { sweeper, logs, notified }
  }

  it('grace: a mention is reported only once it is older than the grace period', async () => {
    const home = scratch('sweeper')
    const spec = join(home, 'sweep.json')
    writeFileSync(spec, JSON.stringify({ results: [inAll('9ace0001', 10_000)] }))
    let skew = 0
    const { sweeper, notified } = sweeperFor(home, spec, { now: () => Date.now() + skew })
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 0 })
    skew = 25_000
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 1 })
    expect(notified.flat().map(mention => mention.shortId)).toEqual(['9ace0001'])
    await sweeper.stop()
  })

  it('busy: new mentions wait while check work is pending, but not past the deferral cap', async () => {
    const home = scratch('sweeper')
    const spec = join(home, 'sweep.json')
    writeFileSync(spec, JSON.stringify({ results: [inAll('b0550001', MINUTE)] }))
    let busy: string | undefined = 'a raft message check call in flight'
    const { sweeper, notified } = sweeperFor(home, spec, { busy: () => busy })
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 0, deferred: 1 })
    busy = undefined
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 1 })
    writeFileSync(spec, JSON.stringify({ results: [inAll('b0550002', 6 * MINUTE)] }))
    busy = 'an unclaimed wake notice'
    const capped = sweeperFor(home, spec, { busy: () => busy })
    expect(await capped.sweeper.sweep()).toEqual({ ok: true, notified: 1 })
    expect(notified.flat().concat(capped.notified.flat()).map(mention => mention.shortId)).toEqual(['b0550001', 'b0550002'])
    await sweeper.stop()
    await capped.sweeper.stop()
  })

  it('a notified mention no turn claimed is queued again by the next process, until claimed', async () => {
    const home = scratch('sweeper')
    const spec = join(home, 'sweep.json')
    writeFileSync(spec, JSON.stringify({ results: [inAll('c1a10001', MINUTE)] }))
    const first = sweeperFor(home, spec)
    expect(await first.sweeper.sweep()).toEqual({ ok: true, notified: 1 })
    await first.sweeper.stop()
    // Restart with the notice lost (never claimed); search no longer returns it.
    writeFileSync(spec, JSON.stringify({ results: [] }))
    const second = sweeperFor(home, spec)
    expect(await second.sweeper.sweep()).toEqual({ ok: true, notified: 1 })
    expect(second.notified[0]!.map(mention => [mention.target, mention.shortId])).toEqual([['#all', 'c1a10001']])
    second.sweeper.markClaimed([{ target: '#all', shortId: 'c1a10001' }])
    await second.sweeper.stop()
    const third = sweeperFor(home, spec)
    expect(await third.sweeper.sweep()).toEqual({ ok: true, notified: 0 })
    expect(third.sweeper.status().unclaimed).toBe(0)
    await third.sweeper.stop()
  })

  it('stops paging at the page cap with a warning', async () => {
    const home = scratch('sweeper')
    const spec = join(home, 'sweep.json')
    writeFileSync(spec, JSON.stringify({ results: Array.from({ length: 101 }, (_, i) => inAll(`ca9a${String(i).padStart(4, '0')}`, MINUTE + i * 1000)) }))
    const { sweeper, notified, logs } = sweeperFor(home, spec, { maxPages: 2 })
    expect(await sweeper.sweep()).toEqual({ ok: true, notified: 100 })
    expect(notified[0]!.map(mention => mention.shortId)).not.toContain('ca9a0100')
    expect(logs.filter(line => line.includes('read 2 full pages (100 results); mentions sent before'))).toHaveLength(1)
    await sweeper.stop()
  })

  it('start() during a running sweep still schedules the periodic sweep', async () => {
    const home = scratch('sweeper')
    const spec = join(home, 'sweep.json')
    writeFileSync(spec, JSON.stringify({ search: 'hang' }))
    const { sweeper } = sweeperFor(home, spec, { timeoutMs: 300 })
    const early = sweeper.sweep()
    sweeper.start()
    expect(await early).toMatchObject({ ok: false })
    await until(() => sweeper.status().runs === 2 && sweeper.status().scheduled, 5000, 'startup sweep and schedule')
    await sweeper.stop()
    expect(sweeper.status().scheduled).toBe(false)
  })
})
