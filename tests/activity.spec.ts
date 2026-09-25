import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ActivityQueue, ActivityRecorder, CONTENT_CAP, capContent, redactCredentials, startChannelServer, validateActivityEvent,
  type ActivityEvent,
} from '../src/index.js'
import { sessionLifecycleEvent } from '../src/activity.js'

function event(n: number): ActivityEvent {
  return { schema: 'raft-activity.v1', eventId: `event_${n}`, hookEventName: 'Stop', status: 'completed', occurredAt: new Date(0).toISOString() }
}

const at = <T extends SessionEvent['type']>(type: T, data: unknown) => ({ type, data, seq: 0 } as unknown as SessionEvent)

describe('activity queue', () => {
  it('drops the oldest past the cap and reports the count once', () => {
    const queue = new ActivityQueue(3)
    for (let n = 1; n <= 5; n += 1) queue.push(event(n))
    expect(queue.size).toBe(3)
    const first = queue.drain(10)
    expect(first.schema).toBe('raft-activity-drain.v1')
    expect(first.events.map(item => item.eventId)).toEqual(['event_3', 'event_4', 'event_5'])
    expect(first.dropped).toBe(2)
    expect(queue.drain(10)).toEqual({ schema: 'raft-activity-drain.v1', events: [], dropped: 0 })
  })

  it('drains at most max (clamped to 1..200), oldest first', () => {
    const queue = new ActivityQueue(500)
    for (let n = 1; n <= 300; n += 1) queue.push(event(n))
    expect(queue.drain(2).events.map(item => item.eventId)).toEqual(['event_1', 'event_2'])
    expect(queue.drain(0).events).toHaveLength(1)
    expect(queue.drain(Number.NaN).events).toHaveLength(50)
    expect(queue.drain(10_000).events).toHaveLength(200)
  })
})

describe('content capping and redaction', () => {
  it('caps at 4096 chars with an explicit marker and flag', () => {
    const long = capContent('x'.repeat(5000))!
    expect(long.text).toHaveLength(CONTENT_CAP)
    expect(long.text.endsWith('\n[truncated]')).toBe(true)
    expect(long.truncated).toBe(true)
    expect(capContent('y'.repeat(CONTENT_CAP))).toEqual({ text: 'y'.repeat(CONTENT_CAP), truncated: false })
    expect(capContent({ a: 1 })).toEqual({ text: '{"a":1}', truncated: false })
    expect(capContent('')).toBeUndefined()
  })

  it('redacts credential-shaped values and known secrets', () => {
    expect(redactCredentials('{"token":"abcdef1234567890","name":"ok"}')).toBe('{"token":"[REDACTED]","name":"ok"}')
    expect(redactCredentials('curl -H "Authorization: Bearer abc.def.ghi123"')).toBe('curl -H "Authorization: Bearer [REDACTED]"')
    expect(redactCredentials('API_KEY=supersecretvalue')).toBe('API_KEY=[REDACTED]')
    expect(redactCredentials('use sk-abcdefghijklmnopqrstu now')).toBe('use [REDACTED] now')
    expect(redactCredentials('the wake token is TOKENVALUE123', ['TOKENVALUE123'])).toBe('the wake token is [REDACTED]')
    expect(redactCredentials('outputTokens: 123456, token_count=99999999')).toBe('outputTokens: 123456, token_count=99999999')
  })
})

describe('event validation (POST /activity)', () => {
  it('rejects unknown fields instead of stripping them', () => {
    expect(() => validateActivityEvent({ ...event(1), transcript_path: '/leak' })).toThrow(/transcript_path is not allowed/)
    expect(() => validateActivityEvent({ ...event(1), thinking: 'x' })).toThrow(/not allowed/)
    expect(() => validateActivityEvent({ ...event(1), schema: 'other' })).toThrow(/schema/)
    expect(() => validateActivityEvent({ ...event(1), toolName: 'bad\nname' })).toThrow(/toolName/)
  })

  it('re-caps content and marks truncation', () => {
    const checked = validateActivityEvent({ ...event(1), hookEventName: 'PostToolUse', toolName: 'bash', toolOutput: 'z'.repeat(9000) })
    expect(checked.toolOutput).toHaveLength(CONTENT_CAP)
    expect(checked).toMatchObject({ toolOutputTruncated: true, truncated: true })
  })

  it('is served by the endpoint with token auth', async () => {
    const queue = new ActivityQueue(10)
    const server = await startChannelServer({ host: '127.0.0.1', port: 0, token: 'secret-token', activityQueue: queue, wake: async () => ({ ok: true, runtimeSession: 's' }) })
    const url = server.url.replace(/\/wake$/, '/activity')
    const post = (body: unknown, token = 'secret-token') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-raft-bridge-token': token }, body: JSON.stringify(body) })
    try {
      expect((await post(event(1), 'wrong-token!')).status).toBe(401)
      expect((await post({ ...event(1), transcript_path: '/x' })).status).toBe(400)
      expect((await post(event(1))).status).toBe(202)
      expect(queue.size).toBe(1)
      expect((await fetch(server.url.replace(/\/wake$/, '/nope'))).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('session event mapping', () => {
  it('maps turns and tools, times results, and ignores assistant output', () => {
    const out: ActivityEvent[] = []
    let now = 1_000
    const recorder = new ActivityRecorder('raft-p-1', item => { out.push(item) }, () => ['SECRET-TOKEN-1'], () => new Date(now))
    recorder.record(at('turn/start', { turn: 1 }))
    recorder.record(at('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'model words' }] }, stream: [] }))
    recorder.record(at('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo SECRET-TOKEN-1"}' }))
    now += 250
    recorder.record(at('tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] }, error: { name: 'Error', code: 'EXIT_1' } }))
    recorder.record(at('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'x' } } }))
    expect(out.map(item => [item.hookEventName, item.status, item.toolName, item.errorClass])).toEqual([
      ['UserPromptSubmit', 'started', undefined, undefined],
      ['PreToolUse', 'started', 'bash', undefined],
      ['PostToolUseFailure', 'failed', 'bash', 'EXIT_1'],
      ['Stop', 'failed', undefined, 'SERVER'],
    ])
    expect(out[1]!.toolInput).toBe('{"command":"echo [REDACTED]"}')
    expect(out[2]).toMatchObject({ toolOutput: 'boom', durationMs: 250, sessionId: 'raft-p-1' })
    expect(JSON.stringify(out)).not.toContain('model words')
    expect(sessionLifecycleEvent('SessionStart', 'raft-p-1')).toMatchObject({ hookEventName: 'SessionStart', status: 'started' })
  })
})
