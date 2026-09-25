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
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
/** The subset of `@deepseek-ai/dsh-agent-preset-registry`'s `ctx.agentPresets` this plugin uses. */
export interface AgentPresetsView {
    readonly defaultId: string;
    resolve(id?: string): Promise<{
        readonly id: string;
        readonly broken?: string;
    }>;
    acquireScope(id?: string): Promise<AsyncDisposable>;
    mount(ctx: Context, id?: string): Promise<{
        readonly id: string;
    }>;
}
/** The subset of `@deepseek-ai/dsh-workspace`'s `ctx.workspaceRegistry` this plugin uses. */
export interface WorkspaceRegistryView {
    create(path: string): Promise<{
        attachSession(sessionId: SessionId): Promise<void>;
    }>;
}
/** Model-visible shell tools; without one the agent cannot run the `raft` CLI. */
export declare const SHELL_TOOLS: readonly string[];
/** A preset that cannot be resolved or mounted: a startup-fatal configuration error. */
export declare class AgentPresetError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Whether `error` (or any cause) is an {@link AgentPresetError}. */
export declare function isAgentPresetError(error: unknown): boolean;
/** The subset of `@deepseek-ai/dsh-tools`' `ctx.tools` the self-check uses. */
export interface ToolsView {
    schemas(scope?: object): ReadonlyArray<{
        readonly name: string;
    }>;
}
/** Names of the tool schemas an Agent's requests carry, or undefined without a tool registry. */
export declare function visibleToolNames(ctx: Context, agent: object): string[] | undefined;
export declare function presetRegistry(ctx: Context): AgentPresetsView | undefined;
export declare function workspaceRegistry(ctx: Context): WorkspaceRegistryView | undefined;
/**
 * Resolve the configured preset (or the registry's current default) and
 * reject one the registry reports unusable.
 * @throws AgentPresetError carrying the registry's own error text.
 */
export declare function resolvePreset(presets: AgentPresetsView, configured: string | undefined): Promise<string>;
/** Hold the preset revision across an Agent creation (released by the returned disposer). */
export declare function acquirePreset(presets: AgentPresetsView, id: string): Promise<AsyncDisposable>;
/** Join an unpublished Agent to a preset from its setup callback. */
export declare function mountPreset(presets: AgentPresetsView, agentCtx: Context, id: string): Promise<void>;
/**
 * The preset a session runs under: its creation header advanced by the last
 * `agent-preset/selected` event (as the registry's projection and the
 * headless runner read it), or undefined when it recorded none.
 * @throws AgentPresetError on a malformed selection record: reading it as "no
 *   preset" would silently recompose the session.
 */
export declare function recordedPreset(session: Pick<Session, 'id' | 'header' | 'snapshotEvents'>): string | undefined;
