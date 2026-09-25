/**
 * Optional live checks against the installed raft CLI (network): the real
 * bridge must start against this endpoint with the expected Agent id and stay
 * up. Opt in with RAFT_LIVE_PROFILE and RAFT_LIVE_AGENT_ID; bridge state goes
 * to a scratch dir.
 *
 * The first check keeps activity off, so nothing is forwarded to the server.
 * The second (also RAFT_LIVE_ACTIVITY=1) turns activity on and exercises the
 * real /activity/drain → server ingest path, including the SessionEnd flush at
 * dispose; it changes the Agent's activity shown in Raft, nothing else.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { host, mountChannel, scratch, until, type Host } from './harness.js'

const profile = process.env.RAFT_LIVE_PROFILE
const agentId = process.env.RAFT_LIVE_AGENT_ID
const withActivity = process.env.RAFT_LIVE_ACTIVITY === '1'

interface DrainLine { outcome: string; forwardedCount: number; rejectedCount: number }

function drains(h: Host, marker: string): DrainLine[] {
  const out: DrainLine[] = []
  for (const line of h.logs) {
    const at = line.text.indexOf(marker)
    if (at < 0 || !line.text.includes('agent_comms.activity_drain')) continue
    try {
      out.push(JSON.parse(line.text.slice(at + marker.length).trim()) as DrainLine)
    } catch { /* not a JSON line */ }
  }
  return out
}

describe.skipIf(profile === undefined || agentId === undefined)('live raft agent bridge', () => {
  let h: Host | undefined

  afterEach(async () => {
    await h?.ctx.fiber.dispose()
    h = undefined
    vi.unstubAllEnvs()
  })

  function live(): string {
    const home = scratch('live')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('RAFT_AGENT_BRIDGE_STATE_DIR', join(home, 'bridge-state'))
    vi.stubEnv('SLOCK_PROFILE', undefined)
    return home
  }

  it('starts against the endpoint with --expected-agent and stays running', async () => {
    live()
    h = await host()
    const { channel } = await mountChannel(h, { profile, expectedAgentId: agentId, activity: { enabled: false } })
    await until(() => h!.logs.some(line => line.text.includes('bridge_process_started')), 30_000, 'bridge_process_started')
    await new Promise(resolve => setTimeout(resolve, 5000))
    if (process.env.RAFT_LIVE_DUMP !== undefined) writeFileSync(process.env.RAFT_LIVE_DUMP, JSON.stringify(h.logs, null, 1))
    const bridge = channel.status().bridge!
    expect(bridge.state).toBe('running')
    expect(bridge.restartCount).toBe(0)
    expect(h.logs.filter(line => line.type === 'error')).toEqual([])
  }, 60_000)

  it.skipIf(!withActivity)('forwards drained activity to the server and flushes SessionEnd at dispose', async () => {
    live()
    const current = await host()
    h = current
    const { channel } = await mountChannel(current, { profile, expectedAgentId: agentId })
    // SessionStart is queued at startup; the stream bridge drains on each
    // wake-hint chunk (the server heartbeats about every 25s).
    await until(() => drains(current, '[raft bridge]').some(d => d.outcome === 'forwarded'), 90_000, 'forwarded activity drain')
    expect(drains(current, '[raft bridge]').every(d => d.outcome !== 'failed' && d.rejectedCount === 0)).toBe(true)
    expect(channel.status().bridge).toMatchObject({ state: 'running', restartCount: 0 })
    await current.ctx.fiber.dispose()
    h = undefined
    if (process.env.RAFT_LIVE_DUMP !== undefined) writeFileSync(process.env.RAFT_LIVE_DUMP, JSON.stringify(current.logs, null, 1))
    const flushed = drains(current, '[raft bridge flush]')
    expect(flushed.some(d => d.outcome === 'forwarded' && d.forwardedCount >= 1 && d.rejectedCount === 0)).toBe(true)
    expect(current.logs.filter(line => line.type === 'error')).toEqual([])
  }, 150_000)
})
