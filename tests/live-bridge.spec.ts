/**
 * Optional live check against the installed raft CLI (network): the real
 * bridge must start against this endpoint with the expected Agent id and stay
 * up. Opt in with RAFT_LIVE_PROFILE and RAFT_LIVE_AGENT_ID. Activity is off so
 * nothing is forwarded to the server; bridge state goes to a scratch dir.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { host, mountChannel, scratch, until, type Host } from './harness.js'

const profile = process.env.RAFT_LIVE_PROFILE
const agentId = process.env.RAFT_LIVE_AGENT_ID

describe.skipIf(profile === undefined || agentId === undefined)('live raft agent bridge', () => {
  let h: Host | undefined

  afterEach(async () => {
    await h?.ctx.fiber.dispose()
    vi.unstubAllEnvs()
  })

  it('starts against the endpoint with --expected-agent and stays running', async () => {
    const home = scratch('live')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('RAFT_AGENT_BRIDGE_STATE_DIR', join(home, 'bridge-state'))
    vi.stubEnv('SLOCK_PROFILE', undefined)
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
})
