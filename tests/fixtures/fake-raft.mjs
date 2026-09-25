#!/usr/bin/env node
// Stand-in for `raft agent bridge`: records argv/env to FAKE_RAFT_LOG and acts
// out FAKE_RAFT_SCENARIO. Never prints the token.
//   serve   stay alive (default)
//   wakes:N POST N wakes to the endpoint with RAFT_CHANNEL_TOKEN, record answers, stay alive
//   exit:C  exit with code C at once (crash loop)
//   fatal   emit bridge_fatal (HTTP 401) + CLI error, exit 1
//   transient  emit bridge_fatal for a transient HTTP 429 (as CLI 0.0.26 does for any non-5xx CliError), exit 1
//   profile-invalid  startup CLI error PROFILE_FILE_INVALID on stderr, exit 1
//   mismatch  CLI identity-mismatch error, exit 1
// With --once (any scenario): drain the activity endpoint once, record what
// came back as {event:'once'}, exit 0 — the shutdown flush of SessionEnd.
//
// `profile show --json` and `message search` (the mention sweep) print what
// CLI 0.0.26 prints, byte for byte in shape, from the JSON file named by
// FAKE_RAFT_SWEEP (absent: this profile, no results), and record their argv to
// FAKE_RAFT_SWEEP_LOG (never to FAKE_RAFT_LOG).
// Paging (`--offset`) and the server's any-term fallback on an empty strict
// first page are mirrored. File shape:
//   { profile?: 'fail' | {name, displayName, id}, search?: 'fail' | 'hang',
//     results?: [{ id, channelType, channelName, parentChannelType?, parentChannelName?,
//                  senderName, senderType, content, createdAt }] }
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const log = process.env.FAKE_RAFT_LOG
const scenario = process.env.FAKE_RAFT_SCENARIO ?? 'serve'
const argv = process.argv.slice(2)
const record = (entry) => { if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`) }

if ((argv[0] === 'profile' && argv[1] === 'show') || (argv[0] === 'message' && argv[1] === 'search')) {
  await sweepCommand()
}

async function sweepCommand() {
  const sweepLog = process.env.FAKE_RAFT_SWEEP_LOG
  if (sweepLog) {
    appendFileSync(sweepLog, `${JSON.stringify({ pid: process.pid, argv, env: {
      RAFT_PROFILE: process.env.RAFT_PROFILE, SLOCK_PROFILE: process.env.SLOCK_PROFILE, RAFT_CHANNEL_TOKEN: process.env.RAFT_CHANNEL_TOKEN,
    } })}\n`)
  }
  const file = process.env.FAKE_RAFT_SWEEP
  const spec = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
  if (argv[0] === 'profile') {
    if (spec.profile === 'fail') {
      process.stderr.write('Error: HTTP 502 Bad Gateway\nCode: SERVER_5XX\n')
      process.exit(1)
    }
    const p = spec.profile ?? { name: process.env.RAFT_PROFILE, displayName: process.env.RAFT_PROFILE, id: 'agent-1' }
    // The real `raft profile show --json` shape (CLI 0.0.26), abridged to the fields that vary.
    process.stdout.write(`${JSON.stringify({ ok: true, data: { kind: 'agent', id: p.id, isSelf: true, name: p.name, displayName: p.displayName, description: null,
      avatarUrl: 'pixel:tree', status: 'inactive', serverRole: 'member', runtime: 'external', model: 'external', reasoningEffort: null, executionMode: 'byoc',
      createdAgents: [], createdAt: '2026-09-25T09:36:46.380Z', deletedAt: null, lastRuntimeError: null } })}\n`)
    process.exit(0)
  }
  if (spec.search === 'fail') {
    process.stderr.write('Error: Search is temporarily unavailable\nCode: SEARCH_UNAVAILABLE\n')
    process.exit(1)
  }
  if (spec.search === 'hang') {
    setInterval(() => {}, 1 << 30)
    await new Promise(() => {})
  }
  const query = (opt('--query') ?? '').trim()
  const words = query.replace(/^@/, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const after = opt('--after') === undefined ? undefined : Date.parse(opt('--after'))
  const target = opt('--target')
  const limit = Math.min(Number(opt('--limit') ?? 20), 50)
  const offset = Number(opt('--offset') ?? 0)
  const candidates = (spec.results ?? [])
    .filter((r) => after === undefined || Date.parse(r.createdAt) > after)
    .filter((r) => target === undefined || targetOf(r) === target)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  // Full-text-like: every word of the query, anywhere (so plain "slicey dsh" matches too).
  let matched = candidates.filter((r) => words.every((word) => r.content.toLowerCase().includes(word)))
  // As the server (searchService.ts:724-727): no strict match on the first page falls back to any term.
  if (matched.length === 0 && offset === 0) matched = candidates.filter((r) => words.some((word) => r.content.toLowerCase().includes(word)))
  const results = matched.slice(offset, offset + limit)
  process.stdout.write(`${formatSearchResults(query, { results })}\n`)
  process.exit(0)
}

function targetOf(r) {
  if (r.channelType === 'thread') return `#${r.parentChannelName}:${r.channelName.slice(7)}`
  return `#${r.channelName}`
}

// --- Copied from the installed CLI 0.0.26 dist (src/commands/message/_format.ts). ---
function pad(n) { return String(n).padStart(2, '0') }
function toLocalTimeWithOffset(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const offsetMinutes = -d.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset}`
}
function neutralizeRaftRefLiterals(text) {
  return text.replace(/\bdm:@([A-Za-z0-9][A-Za-z0-9_-]*)/g, 'dm:user:$1').replace(/\btask #([0-9]+)\b/g, 'task:$1')
    .replace(/(^|[\n\s([{"'`;])@([A-Za-z0-9][A-Za-z0-9_-]*)/g, '$1user:$2').replace(/(^|[\n\s([{"'`;])#([A-Za-z][A-Za-z0-9_-]*)/g, '$1channel:$2')
}
function renderSearchSource(r) {
  if (r.channelType === 'thread') {
    const shortId = typeof r.channelName === 'string' && r.channelName.startsWith('thread-') ? r.channelName.slice(7) : r.channelName
    if (r.parentChannelType === 'dm') return `dm:${neutralizeRaftRefLiterals(r.parentChannelName ?? 'unknown')}:${shortId}`
    return `thread:${neutralizeRaftRefLiterals(r.parentChannelName ?? 'unknown')}:${shortId}`
  }
  if (r.channelType === 'dm') return `dm:${neutralizeRaftRefLiterals(r.channelName ?? 'unknown')}`
  return `channel:${neutralizeRaftRefLiterals(r.channelName ?? 'unknown')}`
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function findSearchMatch(content, query) {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return null
  const exactIndex = content.toLowerCase().indexOf(normalizedQuery.toLowerCase())
  if (exactIndex >= 0) return { start: exactIndex, end: exactIndex + normalizedQuery.length }
  for (const rawTerm of normalizedQuery.match(/"([^"]+)"|\S+/g) ?? []) {
    const term = rawTerm.replace(/^"|"$/g, '').trim()
    if (!term) continue
    const match = new RegExp(escapeRegExp(term), 'i').exec(content)
    if (match?.index !== undefined) return { start: match.index, end: match.index + match[0].length }
  }
  return null
}
function* findRaftRefLiteralRanges(content) {
  for (const match of content.matchAll(/\bdm:@[A-Za-z0-9][A-Za-z0-9_-]*/g)) yield { start: match.index, end: match.index + match[0].length }
  for (const match of content.matchAll(/\btask #[0-9]+\b/g)) yield { start: match.index, end: match.index + match[0].length }
  for (const match of content.matchAll(/(^|[\n\s([{"'`;])(@[A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const prefix = match[1] ?? ''
    yield { start: match.index + prefix.length, end: match.index + prefix.length + match[2].length }
  }
  for (const match of content.matchAll(/(^|[\n\s([{"'`;])(#[A-Za-z][A-Za-z0-9_-]*)/g)) {
    const prefix = match[1] ?? ''
    yield { start: match.index + prefix.length, end: match.index + prefix.length + match[2].length }
  }
}
function expandSearchMatchToRefLiteral(content, match) {
  for (const refRange of findRaftRefLiteralRanges(content)) {
    if (match.start < refRange.end && match.end > refRange.start) return { start: Math.min(match.start, refRange.start), end: Math.max(match.end, refRange.end) }
  }
  return match
}
function trimPreviewWindow(content, start, end) {
  let s = start
  let e = end
  while (s > 0 && /\s/.test(content[s] ?? '')) s += 1
  while (e < content.length && /\s/.test(content[e - 1] ?? '')) e -= 1
  return { start: Math.max(0, Math.min(s, content.length)), end: Math.max(0, Math.min(e, content.length)) }
}
function escapeSearchComponentLiterals(text) {
  return text.replace(/<\/?(?:result|preview|match)\b[^>]*>|<omit\s*\/>/gi, (tag) => tag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
}
function renderPreviewText(text) { return neutralizeRaftRefLiterals(escapeSearchComponentLiterals(text)) }
function renderSearchPreview(content, query) {
  const foundMatch = findSearchMatch(content, query)
  const match = foundMatch ? expandSearchMatchToRefLiteral(content, foundMatch) : null
  let start = 0
  let end = Math.min(content.length, 200)
  if (match) {
    start = Math.max(0, match.start - 80)
    end = Math.min(content.length, match.end + 120)
  }
  ;({ start, end } = trimPreviewWindow(content, start, end))
  const leadingOmit = start > 0 ? '<omit />' : ''
  const trailingOmit = end < content.length ? '<omit />' : ''
  if (!match || match.end <= start || match.start >= end) return `${leadingOmit}${renderPreviewText(content.slice(start, end))}${trailingOmit}`
  return [leadingOmit, renderPreviewText(content.slice(start, match.start)), '<match>', renderPreviewText(content.slice(match.start, match.end)), '</match>',
    renderPreviewText(content.slice(match.end, end)), trailingOmit].join('')
}
function formatSearchResults(query, data) {
  if (!data.results || data.results.length === 0) return 'No search results.'
  const trimmedQuery = query.trim()
  const formatted = data.results.map((r) => [
    `<result ref="msg:${r.id}">`,
    `Source: ${renderSearchSource(r)}`,
    `Sender: ${neutralizeRaftRefLiterals(r.senderName ?? 'unknown')}${r.senderType ? ` (${r.senderType})` : ''}`,
    `Time: ${r.createdAt ? toLocalTimeWithOffset(r.createdAt) : '-'}`,
    '',
    '<preview>',
    renderSearchPreview(r.content ?? '', trimmedQuery),
    '</preview>',
    '</result>',
  ].join('\n')).join('\n\n')
  const resultLabel = data.results.length === 1 ? 'result' : 'results'
  return [
    trimmedQuery ? `Search results for: "${trimmedQuery}" (${data.results.length} ${resultLabel})` : `Filtered message results (${data.results.length} ${resultLabel})`,
    '',
    formatted,
    '',
    'If a result may be relevant but its preview is not enough, read the surrounding context for that result before answering.',
  ].join('\n')
}
// --- end of copy ---

process.on('SIGTERM', () => { record({ event: 'sigterm' }); process.exit(0) })
if (argv.includes('--once')) {
  const i = argv.indexOf('--wake-channel-endpoint')
  const url = new URL(argv[i + 1])
  url.pathname = '/activity/drain'
  url.search = '?max=50'
  try {
    const res = await fetch(url, { headers: { 'x-raft-bridge-token': process.env.RAFT_CHANNEL_TOKEN ?? '' } })
    record({ event: 'once', argv, status: res.status, drained: await res.json() })
  } catch (error) {
    record({ event: 'once', argv, error: String(error) })
  }
  process.exit(0)
}
record({
  argv,
  env: {
    RAFT_PROFILE: process.env.RAFT_PROFILE,
    SLOCK_PROFILE: process.env.SLOCK_PROFILE,
    RAFT_CHANNEL_TOKEN: process.env.RAFT_CHANNEL_TOKEN,
    RAFT_EXPECTED_AGENT_ID: process.env.RAFT_EXPECTED_AGENT_ID,
  },
})

const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
const emit = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`) }

if (scenario.startsWith('exit:')) {
  emit({ type: 'bridge_process_started', pid: process.pid })
  process.exit(Number(scenario.slice(5)))
} else if (scenario === 'fatal') {
  emit({ type: 'bridge_fatal', errorCode: 'BRIDGE_WAKE_HINTS_FAILED', message: 'HTTP 401 Unauthorized' })
  process.stderr.write('Error: HTTP 401 Unauthorized\nCode: BRIDGE_WAKE_HINTS_FAILED\n')
  process.exit(1)
} else if (scenario === 'transient') {
  emit({ type: 'bridge_process_started', pid: process.pid, mode: 'stream' })
  emit({ type: 'bridge_fatal', errorCode: 'BRIDGE_WAKE_STREAM_FAILED', message: 'HTTP 429' })
  process.stderr.write('Error: HTTP 429\nCode: BRIDGE_WAKE_STREAM_FAILED\n')
  process.exit(1)
} else if (scenario === 'profile-invalid') {
  process.stderr.write('Error: /x/credential.json is missing required fields (apiKey, agentId, serverUrl).\nCode: PROFILE_FILE_INVALID\n')
  process.exit(1)
} else if (scenario === 'mismatch') {
  process.stderr.write(`Error: The selected profile resolves to Agent other, but this bridge was started for Agent ${flag('--expected-agent')}. No request was sent.\nCode: BRIDGE_IDENTITY_MISMATCH\nNext action: Select the profile for the expected Agent, then restart the bridge.\n`)
  process.exit(1)
} else {
  emit({ type: 'bridge_process_started', pid: process.pid, mode: 'stream' })
  setInterval(() => {}, 1 << 30)
  if (scenario.startsWith('wakes:')) {
    const count = Number(scenario.slice(6))
    const endpoint = flag('--wake-channel-endpoint')
    const posts = []
    for (let n = 1; n <= count; n += 1) {
      posts.push(fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-raft-bridge-token': process.env.RAFT_CHANNEL_TOKEN ?? '' },
        body: JSON.stringify({
          schema: 'raft-channel-wake.v1', attemptId: `attempt_${n}`, eventId: `event_${n}`, messageId: `message-${n}`,
          agentId: process.env.RAFT_EXPECTED_AGENT_ID, profile: process.env.RAFT_PROFILE, coreSessionId: 'core_fake',
          adapterInstance: 'default', occurredAt: new Date().toISOString(),
        }),
      }).then(async (res) => ({ status: res.status, body: await res.json() }), (err) => ({ status: 0, body: { error: String(err) } })))
    }
    Promise.all(posts).then((answers) => { record({ event: 'answers', answers }) })
  }
}
