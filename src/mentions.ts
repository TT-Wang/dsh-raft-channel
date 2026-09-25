/**
 * The mention sweep. Raft keeps an external agent's inbox in one server
 * process's memory, and #all is a virtual channel the durable inbox rebuild
 * cannot see, so a channel @mention can miss both the wake hint and
 * `raft message check`. The sweep asks `raft message search` (read-only: it
 * moves no read cursor) for recent messages naming the agent's handle and
 * reports the ones no check returned, by target and short id only.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bridgeSpawnPlan, type BridgeLogger } from './bridge.js'
import type { MentionRef } from './text.js'

export const MENTIONS_SCHEMA = 'dsh-raft-channel-mentions.v1'
/** Ids the seen-set (and the checked short-id set) keeps, oldest evicted first. */
export const SEEN_CAP = 2000
/** Per-CLI-call deadline. */
export const CLI_TIMEOUT_MS = 10_000
/** The server caps a search page at 50. */
const SEARCH_LIMIT = 50
/** How far before the watermark a sweep looks again, for messages committed late; the seen-set dedupes. */
const WATERMARK_OVERLAP_MS = 60_000
const OUTPUT_CAP = 4 * 1024 * 1024

/** One `<result>` block of `raft message search` output. */
export interface SearchResult {
  id: string
  /** The `Source:` line: `channel:<name>`, `thread:<parent>:<short>`, `dm:…`. */
  source: string
  /** Display name (the server prefers it over the handle). */
  sender: string
  senderType: string | undefined
  /** Epoch ms, NaN when the line did not parse. */
  time: number
  preview: string
}

export interface Mention extends MentionRef {
  id: string
  sender: string
  time: number
}

export interface SelfProfile {
  handle: string
  displayName: string
}

/**
 * Parse `raft message search` text output (CLI 0.0.26 `formatSearchResults`).
 * "No search results." and anything unrecognised parse to no results.
 */
export function parseSearchOutput(text: string): SearchResult[] {
  const results: SearchResult[] = []
  // The CLI escapes <result>/<preview> literals inside previews, so the first
  // closing tag after an opening one ends that block.
  for (const match of text.matchAll(/^<result ref="msg:([^"\s]+)">\n([\s\S]*?)\n<\/result>$/gm)) {
    const body = match[2]!
    const header = body.split('\n<preview>\n')[0]!.split('\n')
    const field = (name: string): string | undefined => header.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
    const sender = /^(.*?)(?: \(([^()]*)\))?$/.exec(field('Sender') ?? '')
    const previewStart = body.indexOf('<preview>\n')
    const previewEnd = body.lastIndexOf('\n</preview>')
    results.push({
      id: match[1]!,
      source: field('Source') ?? '',
      sender: sender?.[1] ?? '',
      senderType: sender?.[2],
      time: parseSearchTime(field('Time') ?? ''),
      preview: previewStart < 0 || previewEnd < previewStart ? '' : body.slice(previewStart + 10, previewEnd),
    })
  }
  return results
}

/** `2026-09-25 21:01:14 +08:00` (the CLI's local time with offset) → epoch ms, NaN otherwise. */
export function parseSearchTime(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})$/.exec(value.trim())
  return match === null ? Number.NaN : Date.parse(`${match[1]}T${match[2]}${match[3]}`)
}

/**
 * The reply target of a search `Source:`: `channel:<name>` → `#<name>`,
 * `thread:<parent>:<short>` → `#<parent>:<short>`. DM sources name the stored
 * DM channel, not the peer, so they give no usable target (undefined).
 */
export function sourceTarget(source: string): string | undefined {
  const channel = /^channel:([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(source)
  if (channel !== null) return `#${channel[1]}`
  const thread = /^thread:([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9_-]+)$/.exec(source)
  if (thread !== null) return `#${thread[1]}:${thread[2]}`
  return undefined
}

/**
 * Whether a search preview contains an @mention of `handle`. The CLI renders
 * `@x` after whitespace as `user:x` (and wraps the hit in <match>); full-text
 * search also returns messages that merely contain the words, so this is the check.
 */
export function mentionsHandle(preview: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_:-])(?:user:|@)${escaped}(?![A-Za-z0-9_-])`, 'i').test(preview)
}

/** `raft profile show --json` → the agent's handle and display name. */
export function parseProfile(text: string): SelfProfile {
  const value = JSON.parse(text) as { ok?: unknown; data?: { name?: unknown; displayName?: unknown } }
  const name = value.data?.name
  if (value.ok !== true || typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error('raft profile show --json did not name a usable handle')
  }
  const displayName = typeof value.data?.displayName === 'string' && value.data.displayName !== '' ? value.data.displayName : name
  return { handle: name, displayName }
}

/** Short ids of the messages a `raft message check` output delivered (`[target=… msg=<short> …]` headers). */
export function checkShortIds(text: string): string[] {
  return [...text.matchAll(/\[target=\S+ msg=([0-9a-f]{8}) /g)].map(match => match[1]!)
}

interface MentionsFile {
  schema: typeof MENTIONS_SCHEMA
  profile: string
  /** Newest mention time handled (ISO), when any. */
  watermark?: string
  seen: Array<{ id: string; at: string }>
  checked: Array<{ shortId: string; at: string }>
  updatedAt: string
}

/** Insertion-ordered bounded set with first-seen times. */
class Bounded {
  readonly entries = new Map<string, string>()
  add(key: string, at: string): void {
    if (this.entries.has(key)) return
    this.entries.set(key, at)
    while (this.entries.size > SEEN_CAP) this.entries.delete(this.entries.keys().next().value!)
  }
  has(key: string): boolean {
    return this.entries.has(key)
  }
}

export interface SweepOutcome {
  ok: boolean
  /** Mentions a notice now names (0 when none were new or the notice failed). */
  notified: number
  error?: string
}

export interface SweeperOptions {
  command: string
  profile: string
  /** Seen-set and watermark file. */
  file: string
  intervalMs: number
  lookbackMs: number
  targets: string[] | undefined
  logger: BridgeLogger
  /** Queue one notice naming these mentions; false (or a throw) retries them next sweep. */
  notify: (mentions: Mention[], handle: string) => Promise<boolean>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  timeoutMs?: number
  /** Wall clock (ms) compared against server message times. */
  now?: () => number
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MentionSweeper {
  private readonly seen = new Bounded()
  private readonly checked = new Bounded()
  private watermark: number | undefined
  private self: SelfProfile | undefined
  private readonly startedAt: number
  private readonly loaded: Promise<void>
  private running: Promise<SweepOutcome> | undefined
  private timer: NodeJS.Timeout | undefined
  private saving: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly children = new Set<ReturnType<typeof spawn>>()
  private runs = 0
  private lastError: string | undefined

  constructor(private readonly options: SweeperOptions) {
    this.startedAt = this.now()
    this.loaded = this.load()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Sweep once now, then every `intervalMs` after each sweep finishes. */
  start(): void {
    if (this.stopped || this.timer !== undefined || this.running !== undefined) return
    void this.sweep().finally(() => { this.schedule() })
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sweep().finally(() => { this.schedule() })
    }, this.options.intervalMs)
    this.timer.unref()
  }

  status(): { runs: number; seen: number; lastError?: string } {
    return { runs: this.runs, seen: this.seen.entries.size, ...this.lastError === undefined ? {} : { lastError: this.lastError } }
  }

  /** Run one sweep; while one is running, its outcome (never two at once). */
  sweep(): Promise<SweepOutcome> {
    if (this.stopped) return Promise.resolve({ ok: false, notified: 0, error: 'stopped' })
    this.running ??= this.run().finally(() => { this.running = undefined })
    return this.running
  }

  /** Record short ids a `raft message check` returned, so the sweep does not report them again. */
  markChecked(shortIds: readonly string[]): void {
    if (shortIds.length === 0) return
    void this.loaded.then(() => {
      if (this.stopped) return
      const at = new Date(this.now()).toISOString()
      for (const shortId of shortIds) this.checked.add(shortId, at)
      this.persist()
    })
  }

  private async run(): Promise<SweepOutcome> {
    await this.loaded
    this.runs += 1
    let results: SearchResult[]
    let floor: number
    try {
      this.self ??= parseProfile(await this.cli(['profile', 'show', '--json']))
      floor = this.startedAt - this.options.lookbackMs
      if (this.watermark !== undefined) floor = Math.max(floor, this.watermark - WATERMARK_OVERLAP_MS)
      const after = new Date(floor).toISOString()
      results = []
      for (const target of this.options.targets ?? [undefined]) {
        const args = ['message', 'search', '--query', `@${this.self.handle}`, '--sort', 'recent', '--after', after, '--limit', String(SEARCH_LIMIT)]
        if (target !== undefined) args.push('--target', target)
        const page = parseSearchOutput(await this.cli(args))
        if (page.length >= SEARCH_LIMIT) this.options.logger.warn(`raft-channel: mention sweep got a full page (${SEARCH_LIMIT}) of results${target === undefined ? '' : ` in ${target}`}; older mentions in the window are not reported`)
        results.push(...page)
      }
    } catch (error) {
      if (this.stopped) return { ok: false, notified: 0, error: 'stopped' }
      this.lastError = errorText(error)
      this.options.logger.warn(`raft-channel: mention sweep failed (retrying in ${this.options.intervalMs}ms): ${this.lastError}`)
      return { ok: false, notified: 0, error: this.lastError }
    }
    if (this.stopped) return { ok: false, notified: 0, error: 'stopped' }
    const self = this.self
    const at = new Date(this.now()).toISOString()
    const fresh: Mention[] = []
    let newest = this.watermark
    for (const result of results) {
      if (this.seen.has(result.id) || !Number.isFinite(result.time) || result.time < floor) continue
      const target = sourceTarget(result.source)
      const own = result.senderType === 'agent' && (result.sender === self.displayName || result.sender === self.handle)
      const shortId = result.id.slice(0, 8)
      if (own || target === undefined || this.checked.has(shortId) || !mentionsHandle(result.preview, self.handle)) {
        // Nothing to report, now or later: remember it so it is not judged again.
        this.seen.add(result.id, at)
        newest = Math.max(newest ?? result.time, result.time)
        continue
      }
      if (!fresh.some(mention => mention.id === result.id)) fresh.push({ id: result.id, shortId, target, sender: result.sender, time: result.time })
    }
    let notified = 0
    if (fresh.length > 0) {
      fresh.sort((a, b) => a.time - b.time)
      let accepted = false
      try {
        accepted = await this.options.notify(fresh, self.handle)
      } catch (error) {
        this.options.logger.warn(`raft-channel: mention notice failed: ${errorText(error)}`)
      }
      if (accepted) {
        notified = fresh.length
        for (const mention of fresh) {
          this.seen.add(mention.id, at)
          newest = Math.max(newest ?? mention.time, mention.time)
        }
        this.options.logger.info(`raft-channel: mention sweep queued a notice for ${fresh.length} mention(s): ${fresh.map(mention => `${mention.target} ${mention.shortId}`).join(', ')}`)
      } else {
        this.options.logger.warn(`raft-channel: mention sweep could not queue its notice; ${fresh.length} mention(s) are retried next sweep`)
      }
    }
    // Hold the watermark below a mention still owed a notice.
    const owed = notified === 0 && fresh.length > 0 ? fresh[0]!.time : undefined
    if (newest !== undefined) this.watermark = owed === undefined ? newest : Math.min(newest, owed)
    this.lastError = undefined
    this.persist()
    return { ok: true, notified }
  }

  /** Run the raft CLI read-only with the profile's environment; stdout on exit 0. */
  private cli(args: string[]): Promise<string> {
    const { options } = this
    const plan = bridgeSpawnPlan(options.platform ?? process.platform, options.command, args)
    const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS
    return new Promise<string>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(plan.command, plan.args, {
          env: { ...options.env ?? process.env, RAFT_PROFILE: options.profile, SLOCK_PROFILE: options.profile },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: plan.shell,
          windowsHide: true,
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.children.add(child)
      const out: Buffer[] = []
      let outBytes = 0
      let err = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        outBytes += chunk.length
        if (outBytes <= OUTPUT_CAP) out.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => { if (err.length < 2000) err += chunk.toString('utf8') })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(new Error(`raft ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
      let done = false
      const settle = (error: Error | undefined, value?: string): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.children.delete(child)
        if (error === undefined) resolve(value!)
        else reject(error)
      }
      child.once('error', error => { settle(error) })
      child.once('close', (code, signal) => {
        if (code === 0) {
          if (outBytes > OUTPUT_CAP) settle(new Error(`raft ${args.slice(0, 2).join(' ')} printed more than ${OUTPUT_CAP} bytes`))
          else settle(undefined, Buffer.concat(out).toString('utf8'))
          return
        }
        const reason = err.trim().split('\n').slice(0, 2).join(' ').slice(0, 300)
        settle(new Error(`raft ${args.slice(0, 2).join(' ')} exited code=${code ?? 'null'} signal=${signal ?? 'null'}${reason === '' ? '' : `: ${reason}`}`))
      })
    })
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.options.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.logger.warn(`raft-channel: cannot read ${this.options.file}: ${errorText(error)}; starting an empty seen-set`)
      return
    }
    try {
      const value = JSON.parse(text) as Partial<MentionsFile>
      if (value.schema !== MENTIONS_SCHEMA || !Array.isArray(value.seen) || !Array.isArray(value.checked)) throw new Error(`not a ${MENTIONS_SCHEMA} record`)
      for (const entry of value.seen) if (typeof entry?.id === 'string') this.seen.add(entry.id, String(entry.at))
      for (const entry of value.checked) if (typeof entry?.shortId === 'string') this.checked.add(entry.shortId, String(entry.at))
      const watermark = value.watermark === undefined ? Number.NaN : Date.parse(value.watermark)
      if (Number.isFinite(watermark)) this.watermark = watermark
    } catch (error) {
      this.options.logger.warn(`raft-channel: ${this.options.file} is unusable (${errorText(error)}); starting an empty seen-set`)
    }
  }

  /** Queue an atomic write of the current state after any earlier one. */
  private persist(): void {
    const state: MentionsFile = {
      schema: MENTIONS_SCHEMA,
      profile: this.options.profile,
      ...this.watermark === undefined ? {} : { watermark: new Date(this.watermark).toISOString() },
      seen: [...this.seen.entries].map(([id, at]) => ({ id, at })),
      checked: [...this.checked.entries].map(([shortId, at]) => ({ shortId, at })),
      updatedAt: new Date(this.now()).toISOString(),
    }
    const file = this.options.file
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
        await rename(temp, file)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    }).catch((error: unknown) => {
      this.options.logger.warn(`raft-channel: could not write ${file}: ${errorText(error)}`)
    })
  }

  /** Stop the timer, kill a running CLI call and wait for the last write. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const child of this.children) child.kill('SIGKILL')
    await this.running?.catch(() => undefined)
    await this.loaded.catch(() => undefined)
    await this.saving
  }
}
