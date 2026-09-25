/**
 * Agent-preset and workspace composition for the Raft session.
 *
 * In a composition with the agent-preset registry (the web-app bundle),
 * model-visible tools live inside presets: an Agent that joins none sees only
 * globally registered tools, so it cannot run `raft message check`. The
 * registry and the workspace registry are optional services: headless-like
 * compositions have neither and expose their tools globally.
 *
 * Both are read through minimal structural views so the published types of
 * this package never depend on the optional peers; the tests pin the views
 * against the real registry types.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** The subset of `@deepseek-ai/dsh-agent-preset-registry`'s `ctx.agentPresets` this plugin uses. */
export interface AgentPresetsView {
  readonly defaultId: string
  resolve(id?: string): Promise<{ readonly id: string; readonly broken?: string }>
  acquireScope(id?: string): Promise<AsyncDisposable>
  mount(ctx: Context, id?: string): Promise<{ readonly id: string }>
}

/** The subset of `@deepseek-ai/dsh-workspace`'s `ctx.workspaceRegistry` this plugin uses. */
export interface WorkspaceRegistryView {
  create(path: string): Promise<{ attachSession(sessionId: SessionId): Promise<void> }>
}

/** Model-visible shell tools; without one the agent cannot run the `raft` CLI. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']

/** A preset that cannot be resolved or mounted: a startup-fatal configuration error. */
export class AgentPresetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentPresetError'
  }
}

/** Whether `error` (or any cause) is an {@link AgentPresetError}. */
export function isAgentPresetError(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause.name === 'AgentPresetError') return true
  }
  return false
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The subset of `@deepseek-ai/dsh-tools`' `ctx.tools` the self-check uses. */
export interface ToolsView {
  schemas(scope?: object): ReadonlyArray<{ readonly name: string }>
}

/** Names of the tool schemas an Agent's requests carry, or undefined without a tool registry. */
export function visibleToolNames(ctx: Context, agent: object): string[] | undefined {
  const tools = (ctx.get as (name: string) => unknown)('tools') as ToolsView | undefined
  return tools?.schemas(agent).map(schema => schema.name)
}

export function presetRegistry(ctx: Context): AgentPresetsView | undefined {
  return (ctx.get as (name: string) => unknown)('agentPresets') as AgentPresetsView | undefined
}

export function workspaceRegistry(ctx: Context): WorkspaceRegistryView | undefined {
  return (ctx.get as (name: string) => unknown)('workspaceRegistry') as WorkspaceRegistryView | undefined
}

/**
 * Resolve the configured preset (or the registry's current default) and
 * reject one the registry reports unusable.
 * @throws AgentPresetError carrying the registry's own error text.
 */
export async function resolvePreset(presets: AgentPresetsView, configured: string | undefined): Promise<string> {
  const wanted = configured ?? presets.defaultId
  let preset: { readonly id: string; readonly broken?: string }
  try {
    preset = await presets.resolve(configured)
  } catch (error) {
    throw new AgentPresetError(`agent preset ${JSON.stringify(wanted)} ${configured === undefined ? '(registry default)' : '(config agentPreset)'} cannot be resolved: ${errorText(error)}`, { cause: error })
  }
  if (preset.broken !== undefined) {
    throw new AgentPresetError(`agent preset ${JSON.stringify(preset.id)} is not usable: ${preset.broken}`)
  }
  return preset.id
}

/** Hold the preset revision across an Agent creation (released by the returned disposer). */
export async function acquirePreset(presets: AgentPresetsView, id: string): Promise<AsyncDisposable> {
  try {
    return await presets.acquireScope(id)
  } catch (error) {
    throw new AgentPresetError(`agent preset ${JSON.stringify(id)} cannot be acquired: ${errorText(error)}`, { cause: error })
  }
}

/** Join an unpublished Agent to a preset from its setup callback. */
export async function mountPreset(presets: AgentPresetsView, agentCtx: Context, id: string): Promise<void> {
  try {
    await presets.mount(agentCtx, id)
  } catch (error) {
    throw new AgentPresetError(`agent preset ${JSON.stringify(id)} cannot be mounted: ${errorText(error)}`, { cause: error })
  }
}

/**
 * The preset a session runs under: its creation header advanced by the last
 * `agent-preset/selected` event (as the registry's projection and the
 * headless runner read it), or undefined when it recorded none.
 * @throws AgentPresetError on a malformed selection record: reading it as "no
 *   preset" would silently recompose the session.
 */
export function recordedPreset(session: Pick<Session, 'id' | 'header' | 'snapshotEvents'>): string | undefined {
  let preset = session.header.agentPreset
  for (const event of session.snapshotEvents()) {
    // Owned by the optional registry package, so read structurally.
    const candidate = event as unknown as { type: string; data?: { agentPreset?: unknown } }
    if (candidate.type !== 'agent-preset/selected') continue
    const selected = candidate.data?.agentPreset
    if (typeof selected !== 'string' || selected === '') {
      throw new AgentPresetError(`session ${session.id} records a malformed agent-preset/selected event`)
    }
    preset = selected
  }
  return preset
}
