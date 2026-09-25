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
import { appendFileSync } from 'node:fs'

const log = process.env.FAKE_RAFT_LOG
const scenario = process.env.FAKE_RAFT_SCENARIO ?? 'serve'
const argv = process.argv.slice(2)
const record = (entry) => { if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`) }

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
