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
      stateFile: '/tmp/dsh-home/raft-channel/slicey-dsh.json',
      exportProfile: false,
    })
  })

  it('rejects unknown keys at every level with the valid list', () => {
    expect(() => resolveConfig({ profil: 'x' }, {}, HOME)).toThrow(/unknown configuration key profil; valid keys: profile, expectedAgentId, raftBin/)
    expect(() => resolveConfig({ profile: 'p', expectedAgentId: ID, bridge: { enable: false } }, {}, HOME)).toThrow(/bridge\.enable; valid keys: enabled, pollIntervalMs, restartBackoffMs/)
    expect(() => resolveConfig({ profile: 'p', expectedAgentId: ID, rotate: { turns: 1 } }, {}, HOME)).toThrow(/rotate\.turns; valid keys: maxTurns, maxHistoryChars/)
    expect(() => resolveConfig({ profile: 'p', expectedAgentId: ID, activity: { cap: 1 } }, {}, HOME)).toThrow(/activity\.cap/)
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
})
