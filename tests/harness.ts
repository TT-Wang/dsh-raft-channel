/** Real DSH services with only the model replaced; the plugin under test mounts on top. */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type ModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as loopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import Invariants from '@deepseek-ai/dsh-invariants'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import RaftChannel, { type Config } from '../src/index.js'

export const FAKE_RAFT = new URL('./fixtures/fake-raft.mjs', import.meta.url).pathname
export const PROVIDER = 'raft-mock'
export const MODEL = 'mock-1'

export function text(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCall(id: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted adapter: queued responses, then a default text reply; an optional gate holds every request. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly queue: StreamChunk[][] = []
  gate: Promise<void> | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.gate !== undefined) await this.gate
    for (const chunk of this.queue.shift() ?? text('checked Raft')) yield chunk
  }
}

/** Stand-in for the default-model row of dsh-base. */
class FakeDefaultModel extends Service {
  constructor(ctx: Context) { super(ctx, 'agentDefaultModel') }
  currentSelection(): ModelSelection { return { provider: PROVIDER, model: MODEL } }
}

export interface HostOptions {
  persistenceRoot?: string
}

/** Mount the stock loop, invariants, optional JSONL persistence and a scripted model. */
export async function host(options: HostOptions = {}) {
  const ctx = new Context()
  const logs: Array<{ type: string; text: string }> = []
  ctx.logger.exporter({ levels: { default: 3 }, export(message) { logs.push({ type: message.type, text: message.args.map(String).join(' ') }) } })
  const adapter = new ScriptedAdapter()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Raft channel fixture.' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  if (options.persistenceRoot !== undefined) await ctx.plugin(JsonlPersistence, { root: options.persistenceRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Invariants)
  await ctx.plugin(sessionInvariant)
  await ctx.plugin(loopInvariant)
  await ctx.plugin(FakeDefaultModel)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo the input back.',
    parameters: { value: { type: 'string', required: true, description: 'Text to echo.' } },
    output: { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
    execute: async (args: unknown) => `echo:${(args as { value: string }).value}`,
  }))
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  return { ctx, adapter, logs, errors }
}

export type Host = Awaited<ReturnType<typeof host>>

/** A scratch directory under the OS temp dir. */
export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `raft-channel-${prefix}-`))
}

/** Mount the plugin and wait for its startup. */
export async function mountChannel(h: Host, config: Config) {
  const fiber = h.ctx.plugin(RaftChannel, config)
  await fiber
  const channel = h.ctx.get('raftChannel') as RaftChannel
  await channel.whenReady()
  return { fiber, channel }
}

export interface FakeRaftRecord {
  pid: number
  argv: string[]
  env: Record<string, string | undefined>
  event?: string
  answers?: Array<{ status: number; body: Record<string, unknown> }>
  /** `--once` flush: the drain answer it received. */
  drained?: { schema: string; events: Array<Record<string, unknown>>; dropped: number }
}

/** Records the fake raft executable appended to its log file. */
export function fakeRaftRecords(log: string): FakeRaftRecord[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as FakeRaftRecord)
}

/** Poll until `predicate` holds (10ms steps). */
export async function until(predicate: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The wake body the CLI sends (raft-channel-wake.v1). */
export function wakeBody(n = 1): Record<string, string> {
  return {
    schema: 'raft-channel-wake.v1',
    attemptId: `attempt_${n}`,
    eventId: `event_${n}`,
    messageId: `message-${n}`,
    agentId: 'agent-1',
    profile: 'test-profile',
    coreSessionId: 'core_1',
    adapterInstance: 'default',
    occurredAt: '2026-09-25T00:00:00.000Z',
  }
}

export async function postWake(url: string, token: string | undefined, body: unknown = wakeBody()) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...token === undefined ? {} : { 'x-raft-bridge-token': token } },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}
