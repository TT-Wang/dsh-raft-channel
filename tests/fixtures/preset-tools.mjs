// A preset row registering one tool per configured name. Import-free: the
// Loader resolves entry modules through Node's ESM resolver.
export const name = 'preset-tools'
export const inject = ['tools']

export function apply(ctx, config) {
  for (const tool of config.tools) {
    ctx.effect(() => ctx.tools.register({
      name: tool,
      description: `preset fixture tool ${tool}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.resolve(tool),
    }))
  }
}
