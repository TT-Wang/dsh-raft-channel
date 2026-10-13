/**
 * The DSH host loads this bundle only when every @deepseek-ai/dsh-* peer range
 * admits the running host version; otherwise it starts without the plugin and
 * only prints one line on stderr. pnpm's peer check does not compare a
 * package's own peer ranges with what is installed, so these tests do: they
 * fail when the DSH devDependencies move and the peer ranges are left behind.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
const peers = Object.entries(readJson('package.json').peerDependencies as Record<string, string>)
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

describe('package manifest', () => {
  it('gives every DSH peer the same list of exact versions', () => {
    expect(peers.length).toBeGreaterThan(0)
    expect(new Set(peers.map(([, range]) => range)).size).toBe(1)
    // The host matches ranges with includePrerelease, so `^0.2.0-rc.2` would also admit 0.2.1 alphas.
    for (const version of peers[0]![1].split('||')) expect(version.trim()).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })

  it('admits the installed DSH version on every DSH peer', () => {
    for (const [name, range] of peers) {
      const installed = readJson(`node_modules/${name}/package.json`).version
      expect(range.split('||').map(version => version.trim()), `${name}: ${range}`).toContain(installed)
    }
  })
})
