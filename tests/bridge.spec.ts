/** Bridge supervision against a fake `raft` executable. */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeSupervisor, bridgeSpawnPlan, type BridgeLogger } from '../src/index.js'
import { FAKE_RAFT, fakeRaftRecords, scratch, until } from './harness.js'

function capture(): BridgeLogger & { lines: Array<[string, string]> } {
  const lines: Array<[string, string]> = []
  const at = (type: string) => (...args: unknown[]) => { lines.push([type, args.map(String).join(' ')]) }
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

describe('bridge supervisor', () => {
  let log: string
  let supervisor: BridgeSupervisor | undefined
  let session = 'raft-p-1'

  beforeEach(() => {
    log = join(scratch('bridge'), 'fake-raft.log')
    session = 'raft-p-1'
  })

  afterEach(async () => {
    await supervisor?.stop()
    supervisor = undefined
    vi.unstubAllEnvs()
  })

  function make(scenario: string, extra: Partial<ConstructorParameters<typeof BridgeSupervisor>[0]> = {}) {
    const logger = capture()
    supervisor = new BridgeSupervisor({
      command: FAKE_RAFT,
      profile: 'p',
      expectedAgentId: 'agent-1',
      endpoint: 'http://127.0.0.1:9/wake',
      token: 'token-token-token',
      runtimeSession: () => session,
      restartBackoffMs: [50, 200],
      logger,
      env: { ...process.env, FAKE_RAFT_LOG: log, FAKE_RAFT_SCENARIO: scenario },
      ...extra,
    })
    return { supervisor, logger }
  }

  it('restarts an exiting child with exponential backoff and a fresh --runtime-session', async () => {
    const { supervisor, logger } = make('exit:3')
    supervisor.start()
    await until(() => fakeRaftRecords(log).length >= 1, 5000, 'first spawn')
    session = 'raft-p-2'
    await until(() => supervisor.getStatus().restartCount >= 4, 10_000, 'restarts')
    const delays = logger.lines.filter(([, line]) => line.includes('restart #')).map(([, line]) => Number(/in (\d+)ms/.exec(line)![1]))
    expect(delays.slice(0, 4)).toEqual([50, 100, 200, 200])
    const records = fakeRaftRecords(log)
    expect(records.length).toBeGreaterThanOrEqual(3)
    expect(records.at(-1)!.argv).toContain('raft-p-2')
    expect(logger.lines.some(([type, line]) => type === 'info' && line.includes('bridge_process_started'))).toBe(true)
    await supervisor.stop()
    const count = fakeRaftRecords(log).length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(fakeRaftRecords(log).length).toBe(count)
    expect(supervisor.getStatus().state).toBe('stopped')
  })

  it('stops restarting after bridge_fatal and reports revoked auth loudly', async () => {
    const { supervisor, logger } = make('fatal')
    supervisor.start()
    await until(() => supervisor.getStatus().state === 'auth_revoked', 5000, 'terminal state')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fakeRaftRecords(log)).toHaveLength(1)
    expect(supervisor.getStatus()).toMatchObject({ state: 'auth_revoked', terminalCode: 'BRIDGE_WAKE_HINTS_FAILED', restartCount: 0 })
    expect(logger.lines.some(([type, line]) => type === 'error' && line.includes('stopped for good'))).toBe(true)
  })

  it('restarts with backoff after a transient bridge_fatal (HTTP 429) instead of stopping for good', async () => {
    const { supervisor, logger } = make('transient')
    supervisor.start()
    await until(() => fakeRaftRecords(log).length >= 3, 5000, 'respawns after bridge_fatal')
    const status = supervisor.getStatus()
    expect(status.state).not.toBe('fatal')
    expect(status.terminalCode).toBeUndefined()
    expect(status.restartCount).toBeGreaterThanOrEqual(2)
    expect(logger.lines.some(([type, line]) => type === 'error' && line.includes('bridge_fatal BRIDGE_WAKE_STREAM_FAILED') && line.includes('restarting with backoff'))).toBe(true)
    expect(logger.lines.some(([, line]) => line.includes('stopped for good'))).toBe(false)
  })

  it('stops restarting on a broken profile credential (PROFILE_FILE_INVALID)', async () => {
    const { supervisor } = make('profile-invalid')
    supervisor.start()
    await until(() => supervisor.getStatus().state === 'fatal', 5000, 'terminal state')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fakeRaftRecords(log)).toHaveLength(1)
    expect(supervisor.getStatus()).toMatchObject({ terminalCode: 'PROFILE_FILE_INVALID', restartCount: 0 })
  })

  it('stops restarting on an expected-agent mismatch', async () => {
    const { supervisor } = make('mismatch')
    supervisor.start()
    await until(() => supervisor.getStatus().state === 'fatal', 5000, 'terminal state')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fakeRaftRecords(log)).toHaveLength(1)
    expect(supervisor.getStatus()).toMatchObject({ terminalCode: 'BRIDGE_IDENTITY_MISMATCH' })
    expect(supervisor.getStatus().reason).toMatch(/started for Agent agent-1/)
  })

  it('stop() terminates a running child with SIGTERM', async () => {
    const { supervisor } = make('serve')
    supervisor.start()
    await until(() => supervisor.getStatus().state === 'running' && fakeRaftRecords(log).length === 1, 5000, 'running')
    const pid = supervisor.getStatus().pid!
    await supervisor.stop()
    expect(fakeRaftRecords(log).some(record => record.event === 'sigterm' && record.pid === pid)).toBe(true)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(supervisor.getStatus().state).toBe('stopped')
  })

  it('a missing executable backs off instead of crashing', async () => {
    const { supervisor, logger } = make('serve', { command: join(scratch('none'), 'no-such-raft') })
    supervisor.start()
    await until(() => supervisor.getStatus().restartCount >= 2, 5000, 'retries')
    expect(logger.lines.some(([type, line]) => type === 'error' && line.includes('ENOENT'))).toBe(true)
  })

  it('quotes one command string on win32 and passes argv elsewhere', () => {
    expect(bridgeSpawnPlan('darwin', 'raft', ['agent', 'bridge'])).toEqual({ command: 'raft', args: ['agent', 'bridge'], shell: false })
    expect(bridgeSpawnPlan('win32', 'C:\\Program Files\\raft\\raft.cmd', ['agent', 'bridge', '--wake-channel-endpoint', 'http://127.0.0.1:1/wake']))
      .toEqual({ command: '"C:\\Program Files\\raft\\raft.cmd" "agent" "bridge" "--wake-channel-endpoint" "http://127.0.0.1:1/wake"', args: [], shell: true })
  })
})
