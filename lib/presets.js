/** Model-visible shell tools; without one the agent cannot run the `raft` CLI. */
export const SHELL_TOOLS = ['bash', 'pwsh'];
/** A preset that cannot be resolved or mounted: a startup-fatal configuration error. */
export class AgentPresetError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'AgentPresetError';
    }
}
/** Whether `error` (or any cause) is an {@link AgentPresetError}. */
export function isAgentPresetError(error) {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
        if (cause.name === 'AgentPresetError')
            return true;
    }
    return false;
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Names of the tool schemas an Agent's requests carry, or undefined without a tool registry. */
export function visibleToolNames(ctx, agent) {
    const tools = ctx.get('tools');
    return tools?.schemas(agent).map(schema => schema.name);
}
export function presetRegistry(ctx) {
    return ctx.get('agentPresets');
}
export function workspaceRegistry(ctx) {
    return ctx.get('workspaceRegistry');
}
/**
 * Resolve the configured preset (or the registry's current default) and
 * reject one the registry reports unusable.
 * @throws AgentPresetError carrying the registry's own error text.
 */
export async function resolvePreset(presets, configured) {
    const wanted = configured ?? presets.defaultId;
    let preset;
    try {
        preset = await presets.resolve(configured);
    }
    catch (error) {
        throw new AgentPresetError(`agent preset ${JSON.stringify(wanted)} ${configured === undefined ? '(registry default)' : '(config agentPreset)'} cannot be resolved: ${errorText(error)}`, { cause: error });
    }
    if (preset.broken !== undefined) {
        throw new AgentPresetError(`agent preset ${JSON.stringify(preset.id)} is not usable: ${preset.broken}`);
    }
    return preset.id;
}
/** Hold the preset revision across an Agent creation (released by the returned disposer). */
export async function acquirePreset(presets, id) {
    try {
        return await presets.acquireScope(id);
    }
    catch (error) {
        throw new AgentPresetError(`agent preset ${JSON.stringify(id)} cannot be acquired: ${errorText(error)}`, { cause: error });
    }
}
/** Join an unpublished Agent to a preset from its setup callback. */
export async function mountPreset(presets, agentCtx, id) {
    try {
        await presets.mount(agentCtx, id);
    }
    catch (error) {
        throw new AgentPresetError(`agent preset ${JSON.stringify(id)} cannot be mounted: ${errorText(error)}`, { cause: error });
    }
}
/**
 * The preset a session runs under: its creation header advanced by the last
 * `agent-preset/selected` event (as the registry's projection and the
 * headless runner read it), or undefined when it recorded none.
 * @throws AgentPresetError on a malformed selection record: reading it as "no
 *   preset" would silently recompose the session.
 */
export function recordedPreset(session) {
    let preset = session.header.agentPreset;
    for (const event of session.snapshotEvents()) {
        // Owned by the optional registry package, so read structurally.
        const candidate = event;
        if (candidate.type !== 'agent-preset/selected')
            continue;
        const selected = candidate.data?.agentPreset;
        if (typeof selected !== 'string' || selected === '') {
            throw new AgentPresetError(`session ${session.id} records a malformed agent-preset/selected event`);
        }
        preset = selected;
    }
    return preset;
}
