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
/** Pages (by `--offset`) one sweep reads per target: as many results as the seen-set holds. */
export const MAX_SEARCH_PAGES = SEEN_CAP / SEARCH_LIMIT
/**
 * Mentions younger than this are left for the next sweep: the wake hint and
 * `raft message check` usually deliver a mention within seconds, and a sweep
 * that reported it first would only cost a duplicate notice and turn.
 */
export const MENTION_GRACE_MS = 30_000
/** While the agent's own check work is pending, new mentions wait at most this long (from their send time) before a notice. */
export const MAX_DEFER_MS = 5 * 60_000
/** Notified mentions not yet claimed by a turn that the mentions file keeps, oldest dropped first. */
const UNCLAIMED_CAP = 200
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
  // Raft names are Unicode (`NAME_REGEX = /^[\p{L}][\p{L}\p{N}_-]*$/u`), so `#研发` is a channel too.
  const channel = /^channel:([\p{L}\p{N}][\p{L}\p{N}._-]*)$/u.exec(source)
  if (channel !== null) return `#${channel[1]}`
  const thread = /^thread:([\p{L}\p{N}][\p{L}\p{N}._-]*):([A-Za-z0-9_-]+)$/u.exec(source)
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
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_:-])(?:user:|@)${escaped}(?![\\p{L}\\p{N}_-])`, 'iu').test(preview)
}

/** `raft profile show --json` → the agent's handle and display name. */
export function parseProfile(text: string): SelfProfile {
  const value = JSON.parse(text) as { ok?: unknown; data?: { name?: unknown; displayName?: unknown } }
  const name = value.data?.name
  if (value.ok !== true || typeof name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(name)) {
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
  /**
   * Mentions a notice named that no turn has claimed yet. A notice lives in
   * the agent's inbox, which a stop or crash discards, so the next process
   * queues these again.
   */
  unclaimed?: Array<{ id: string; shortId: string; target: string; sender: string; time: string }>
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
  /** New mentions held back because the agent's own check may still deliver them. */
  deferred?: number
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
  /**
   * Why a `raft message check` of the agent may still deliver new mentions
   * (an unclaimed wake notice, a wake turn before its check, a check call in
   * flight), if it may: new mentions then wait for a later sweep.
   */
  busy?: () => string | undefined
  /** Minimum mention age before a report (default {@link MENTION_GRACE_MS}). */
  graceMs?: number
  /** Search pages read per target and sweep (default {@link MAX_SEARCH_PAGES}). */
  maxPages?: number
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
  /** Notified mentions whose notice this process queued and no turn has claimed yet. */
  private readonly unclaimed = new Map<string, Mention>()
  /** Unclaimed mentions a previous process left in the file: its notice is gone, so queue them again. */
  private readonly orphans = new Map<string, Mention>()
  private started = false
  private runs = 0
  private lastError: string | undefined

  constructor(private readonly options: SweeperOptions) {
    this.startedAt = this.now()
    this.loaded = this.load()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * Sweep once now, then every `intervalMs` after each sweep finishes. A sweep
   * already running (an early {@link sweep} call) is awaited first, then this
   * one runs, so the startup sweep always sees the attached session.
   */
  start(): void {
    if (this.stopped || this.started) return
    this.started = true
    const earlier = this.running ?? Promise.resolve()
    void earlier.catch(() => undefined).then(() => this.sweep()).catch(() => undefined).finally(() => { this.schedule() })
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sweep().catch(() => undefined).finally(() => { this.schedule() })
    }, this.options.intervalMs)
    this.timer.unref()
  }

  status(): { runs: number; seen: number; unclaimed: number; scheduled: boolean; lastError?: string } {
    return {
      runs: this.runs,
      seen: this.seen.entries.size,
      unclaimed: this.unclaimed.size + this.orphans.size,
      scheduled: this.timer !== undefined,
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
    }
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

  /**
   * A turn claimed the notice naming these mentions: they no longer need
   * queuing again after a restart. Recorded even after {@link stop}, since a
   * claim can land while the plugin shuts down.
   */
  markClaimed(mentions: readonly MentionRef[]): void {
    if (mentions.length === 0) return
    void this.loaded.then(() => {
      let changed = false
      for (const pool of [this.unclaimed, this.orphans]) {
        for (const [id, mention] of pool) {
          if (mentions.some(ref => ref.target === mention.target && ref.shortId === mention.shortId)) {
            pool.delete(id)
            changed = true
          }
        }
      }
      if (changed) this.persist()
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
      const maxPages = this.options.maxPages ?? MAX_SEARCH_PAGES
      results = []
      for (const target of this.options.targets ?? [undefined]) {
        // Newest first; a message sent meanwhile shifts later pages down, so
        // paging by offset can repeat a result (the id dedupes) but not skip one.
        // An empty strict match makes the server fall back to any-term matches
        // on the first page only, so such a page is followed by an empty one.
        for (let page = 0; ; page += 1) {
          const args = ['message', 'search', '--query', `@${this.self.handle}`, '--sort', 'recent', '--after', after, '--limit', String(SEARCH_LIMIT)]
          if (page > 0) args.push('--offset', String(page * SEARCH_LIMIT))
          if (target !== undefined) args.push('--target', target)
          const got = parseSearchOutput(await this.cli(args))
          results.push(...got)
          if (got.length < SEARCH_LIMIT) break
          if (page + 1 >= maxPages) {
            // More matches in one window than the seen-set could hold: the
            // older rest cannot be tracked anyway, so say so instead of paging on.
            const oldest = Math.min(...got.map(result => result.time).filter(Number.isFinite))
            this.options.logger.warn(`raft-channel: mention sweep read ${maxPages} full pages (${maxPages * SEARCH_LIMIT} results)${target === undefined ? '' : ` in ${target}`}; mentions sent before ${Number.isFinite(oldest) ? new Date(oldest).toISOString() : 'the last page'} in this window are not reported`)
            break
          }
        }
      }
    } catch (error) {
      if (this.stopped) return { ok: false, notified: 0, error: 'stopped' }
      this.lastError = errorText(error)
      this.options.logger.warn(`raft-channel: mention sweep failed (retrying in ${this.options.intervalMs}ms): ${this.lastError}`)
      return { ok: false, notified: 0, error: this.lastError }
    }
    if (this.stopped) return { ok: false, notified: 0, error: 'stopped' }
    const self = this.self
    const now = this.now()
    const at = new Date(now).toISOString()
    // Results sent after `ripe` are not judged yet (nor counted in the
    // watermark, which therefore stays below them): check may still deliver them.
    const ripe = now - (this.options.graceMs ?? MENTION_GRACE_MS)
    const found: Mention[] = []
    let newest = this.watermark
    for (const result of results) {
      if (this.seen.has(result.id) || !Number.isFinite(result.time) || result.time < floor || result.time > ripe) continue
      const target = sourceTarget(result.source)
      const own = result.senderType === 'agent' && (result.sender === self.displayName || result.sender === self.handle)
      const shortId = result.id.slice(0, 8)
      if (!own && target === undefined && !result.source.startsWith('dm:') && mentionsHandle(result.preview, self.handle)) {
        this.options.logger.warn(`raft-channel: mention sweep cannot map source ${JSON.stringify(result.source)} of message ${shortId} to a reply target; not reported`)
      }
      if (own || target === undefined || this.checked.has(shortId) || !mentionsHandle(result.preview, self.handle)) {
        // Nothing to report, now or later: remember it so it is not judged again.
        this.seen.add(result.id, at)
        newest = Math.max(newest ?? result.time, result.time)
        continue
      }
      if (!found.some(mention => mention.id === result.id)) found.push({ id: result.id, shortId, target, sender: result.sender, time: result.time })
    }
    // Orphans (queued by a previous process, never claimed) go first, oldest first.
    const fresh = [...this.orphans.values(), ...found.sort((a, b) => a.time - b.time)]
    let notified = 0
    let deferred = 0
    const busy = found.length > 0 ? this.options.busy?.() : undefined
    if (busy !== undefined && now - found[0]!.time < MAX_DEFER_MS) {
      deferred = found.length
      this.options.logger.debug(`raft-channel: mention sweep holds ${found.length} new mention(s) for a later sweep: ${busy} may still deliver them`)
    } else if (fresh.length > 0) {
      // Tracked before the notice is queued: an idle agent claims it inside notify().
      for (const mention of fresh) this.unclaimed.set(mention.id, mention)
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
          this.orphans.delete(mention.id)
          newest = Math.max(newest ?? mention.time, mention.time)
        }
        this.options.logger.info(`raft-channel: mention sweep queued a notice for ${fresh.length} mention(s): ${fresh.map(mention => `${mention.target} ${mention.shortId}`).join(', ')}`)
      } else {
        for (const mention of fresh) this.unclaimed.delete(mention.id)
        this.options.logger.warn(`raft-channel: mention sweep could not queue its notice; ${fresh.length} mention(s) are retried next sweep`)
      }
    }
    // Hold the watermark below a new mention still owed a notice.
    const owed = notified === 0 && found.length > 0 ? found[0]!.time : undefined
    if (newest !== undefined) this.watermark = owed === undefined ? newest : Math.min(newest, owed)
    this.lastError = undefined
    this.persist()
    return { ok: true, notified, ...deferred > 0 ? { deferred } : {} }
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
      for (const entry of Array.isArray(value.unclaimed) ? value.unclaimed.slice(-UNCLAIMED_CAP) : []) {
        const time = typeof entry?.time === 'string' ? Date.parse(entry.time) : Number.NaN
        if (typeof entry?.id !== 'string' || typeof entry.shortId !== 'string' || typeof entry.target !== 'string' || !Number.isFinite(time)) continue
        this.orphans.set(entry.id, { id: entry.id, shortId: entry.shortId, target: entry.target, sender: String(entry.sender ?? ''), time })
      }
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
      unclaimed: [...this.orphans.values(), ...this.unclaimed.values()].slice(-UNCLAIMED_CAP)
        .map(({ id, shortId, target, sender, time }) => ({ id, shortId, target, sender, time: new Date(time).toISOString() })),
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
