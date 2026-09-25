import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.js'

const HOME = '/tmp/dsh-home'
const ID = '00000000-0000-4000-8000-000000000001'

describe('config', () => {
  it('fills defaults from the environment', () => {
    const config = resolveConfig({}, { RAFT_PROFILE: 'slicey-dsh', RAFT_EXPECTED_AGENT_ID: ID }, HOME)
    expect(config).toEqual({
      profile: 'slicey-dsh',
      expectedAgentId: ID,
      raftBin: 'raft',
      sessionPrefix: 'raft-slicey-dsh',
      cwd: '/tmp/dsh-home/raft-workspaces/slicey-dsh',
      host: '127.0.0.1',
      port: 0,
      debounceMs: 1000,
      bridge: { enabled: true, pollIntervalMs: undefined, restartBackoffMs: [1000, 60_000] },
      activity: { enabled: true, queueCap: 500 },
      rotate: { maxTurns: 300, maxHistoryChars: 1_500_000 },
      sweep: { enabled: true, intervalMs: 60_000, lookbackMs: 900_000, targets: undefined },
      stateFile: '/tmp/dsh-home/raft-channel/slicey-dsh.json',
      exportProfile: false,
      mentionsFile: '/tmp/dsh-home/raft-channel/slicey-dsh-mentions.json',
    })
  })

  it('rejects unknown keys at every level with the valid list', () => {
    expect(() => resolveConfig({ profil: 'x' }, {}, HOME)).toThrow(/unknown configuration key profil; valid keys: profile, expectedAgentId, raftBin/)
    expect(() => resolveConfig({ profile: 'p', expectedAgentId: ID, bridge: { enable: false } }, {}, HOME)).toThrow(/bridge\.enable; valid keys: enabled, pollIntervalMs, restartBackoffMs/)
    expect(() => resolveConfig({ profile: 'p', expectedAgentId: ID, rotate: { turns: 1 } }, {}, HOME)).toThrow(/rotate\.turns; valid keys: maxTurns, maxHistoryChars/)
    expect(() => resolveConfig({ profile: 'p', expectedAgentId: ID, activity: { cap: 1 } }, {}, HOME)).toThrow(/activity\.cap/)
    expect(() => resolveConfig({ profile: 'p', expectedAgentId: ID, sweep: { interval: 1 } }, {}, HOME)).toThrow(/sweep\.interval; valid keys: enabled, intervalMs, lookbackMs, targets/)
  })

  it('applies the CLI profile rules', () => {
    expect(() => resolveConfig({}, { RAFT_PROFILE: 'a', SLOCK_PROFILE: 'b', RAFT_EXPECTED_AGENT_ID: ID }, HOME)).toThrow(/disagree/)
    expect(resolveConfig({}, { RAFT_PROFILE: 'a', SLOCK_PROFILE: 'a', RAFT_EXPECTED_AGENT_ID: ID }, HOME).profile).toBe('a')
    expect(resolveConfig({}, { SLOCK_PROFILE: 'legacy', RAFT_EXPECTED_AGENT_ID: ID }, HOME).profile).toBe('legacy')
    expect(() => resolveConfig({ profile: 'b' }, { RAFT_PROFILE: 'a', RAFT_EXPECTED_AGENT_ID: ID }, HOME)).toThrow(/differs/)
    expect(resolveConfig({ profile: 'b' }, { RAFT_EXPECTED_AGENT_ID: ID }, HOME).exportProfile).toBe(true)
    expect(() => resolveConfig({}, { RAFT_EXPECTED_AGENT_ID: ID }, HOME)).toThrow(/no Raft profile/)
    expect(() => resolveConfig({ profile: '../x' }, { RAFT_EXPECTED_AGENT_ID: ID }, HOME)).toThrow(/not a valid profile slug/)
  })

  it('requires an expected Agent id only while the bridge is enabled', () => {
    expect(() => resolveConfig({ profile: 'p' }, {}, HOME)).toThrow(/RAFT_EXPECTED_AGENT_ID/)
    expect(resolveConfig({ profile: 'p', bridge: { enabled: false } }, {}, HOME).expectedAgentId).toBeUndefined()
    expect(resolveConfig({ profile: 'p', expectedAgentId: 'x' }, { RAFT_EXPECTED_AGENT_ID: ID }, HOME).expectedAgentId).toBe('x')
  })

  it('validates numbers and paths', () => {
    const base = { profile: 'p', expectedAgentId: ID }
    expect(() => resolveConfig({ ...base, port: 70_000 }, {}, HOME)).toThrow(/port/)
    expect(() => resolveConfig({ ...base, debounceMs: -1 }, {}, HOME)).toThrow(/debounceMs/)
    expect(() => resolveConfig({ ...base, bridge: { restartBackoffMs: [5000, 10] } }, {}, HOME)).toThrow(/restartBackoffMs\[1\]/)
    expect(() => resolveConfig({ ...base, rotate: { maxTurns: 0 } }, {}, HOME)).toThrow(/maxTurns/)
    expect(() => resolveConfig({ ...base, cwd: 'relative/dir' }, {}, HOME)).toThrow(/absolute/)
    expect(resolveConfig({ ...base, cwd: '/work/raft', sessionPrefix: 'bot' }, {}, HOME)).toMatchObject({ cwd: '/work/raft', sessionPrefix: 'bot' })
    expect(resolveConfig(base, {}, HOME).agentPreset).toBeUndefined()
    expect(resolveConfig({ ...base, agentPreset: ' standard ' }, {}, HOME).agentPreset).toBe('standard')
    expect(() => resolveConfig({ ...base, agentPreset: '' }, {}, HOME)).toThrow(/agentPreset must be a non-empty string/)
  })

  it('validates the mention sweep and keeps it on without the bridge unless disabled', () => {
    const base = { profile: 'p', expectedAgentId: ID }
    expect(resolveConfig({ profile: 'p', bridge: { enabled: false } }, {}, HOME).sweep.enabled).toBe(true)
    expect(resolveConfig({ ...base, sweep: { enabled: false } }, {}, HOME).sweep.enabled).toBe(false)
    expect(() => resolveConfig({ ...base, sweep: { intervalMs: 14_999 } }, {}, HOME)).toThrow(/sweep\.intervalMs must be an integer in \[15000,/)
    expect(() => resolveConfig({ ...base, sweep: { lookbackMs: -1 } }, {}, HOME)).toThrow(/sweep\.lookbackMs/)
    expect(() => resolveConfig({ ...base, sweep: { enabled: 'yes' } }, {}, HOME)).toThrow(/sweep\.enabled must be a boolean/)
    expect(resolveConfig({ ...base, sweep: { targets: [' #all ', '#dev:0ffb9edf'] } }, {}, HOME).sweep.targets).toEqual(['#all', '#dev:0ffb9edf'])
    expect(() => resolveConfig({ ...base, sweep: { targets: [] } }, {}, HOME)).toThrow(/sweep\.targets must be a non-empty list/)
    expect(() => resolveConfig({ ...base, sweep: { targets: 'all' } }, {}, HOME)).toThrow(/sweep\.targets must be a non-empty list/)
    expect(() => resolveConfig({ ...base, sweep: { targets: ['dm:@alice'] } }, {}, HOME)).toThrow(/is not a channel target/)
    expect(() => resolveConfig({ ...base, sweep: { targets: ['all'] } }, {}, HOME)).toThrow(/is not a channel target/)
  })
})
