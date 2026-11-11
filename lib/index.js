import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { buildDigest } from './digest.js'
import { resolveConfig } from './config.js'
import { parseMemory } from './memory.js'
import { sessionDirectory, targetFor, verifySync, workspaceRoot } from './paths.js'
import { readPrefix } from './store.js'
import { makeTools } from './tools.js'

/**
 * dsh-workspace-memory: workspace-scoped durable memory.
 *
 * One Markdown file per workspace is the source of truth. The plugin adds a
 * small, automatically refreshed index to each session's runtime context and
 * six tools that read and update the file. It never appends to session
 * history and never calls a model.
 *
 * `tools` is deliberately not declared in `inject`: a profile that only wants
 * the injected index must still load, and the tools row is looked up
 * optionally below.
 */

const CONTEXT_NAME = 'dsh-workspace-memory'
const CONTEXT_ORDER = 62

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logInfo = (message) => {
    try {
      ctx.logger?.info?.(`dsh-workspace-memory: ${message}`)
    } catch {
      // Logging must never break activation.
    }
  }

  if (!config.enabled) {
    logInfo('disabled by config')
    return
  }

  const warned = new Set()
  const warnOnce = (key, error) => {
    if (warned.has(key)) return
    warned.add(key)
    try {
      ctx.logger?.warn?.(`dsh-workspace-memory: ${key}: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // Ignore logging failures.
    }
  }

  /** @type {Map<string, { mtimeMs: number, size: number, text: string, refreshing: Promise<string> | null }>} */
  const cache = new Map()
  /** @type {Map<string, () => void>} */
  const attached = new Map()

  function remember(target, entry) {
    cache.set(target, entry)
    if (cache.size > 256) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }

  function resolveAgent(agent) {
    const directory = sessionDirectory(agent, ctx)
    if (!directory) throw new Error('this tool needs a live conversation workspace')
    const root = workspaceRoot(directory, ctx)
    const target = targetFor(root, config.memoryFile)
    return { directory, root, target }
  }

  function refresh(target) {
    if (!config.inject) return Promise.resolve('')
    const entry = cache.get(target)
    if (entry?.refreshing) return entry.refreshing

    const promise = (async () => {
      let text = ''
      let signature = { mtimeMs: 0, size: -1 }
      try {
        const info = await stat(target)
        signature = { mtimeMs: info.mtimeMs, size: info.size }
        if (info.isFile()) {
          const raw = await readPrefix(target, config.maxFileBytes)
          text = buildDigest(parseMemory(raw.text), {
            filePath: target,
            injectBudget: config.injectBudget,
            tools: config.tools,
          })
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') warnOnce(`read:${target}`, error)
      }
      remember(target, { ...signature, text, refreshing: null })
      return text
    })()

    remember(target, { ...(entry ?? { mtimeMs: 0, size: -1, text: '' }), refreshing: promise })
    promise
      .finally(() => {
        const current = cache.get(target)
        if (current?.refreshing === promise) current.refreshing = null
      })
      .catch(() => {})
    return promise
  }

  /**
   * Synchronous provider for the per-agent runtime context.
   *
   * DSH calls this while assembling a request, so it must not await. It
   * returns the cached digest and refreshes in the background when the file
   * changed (hand edits included); a tool write refreshes eagerly instead.
   */
  function digestFor(agent) {
    try {
      const { root, target } = resolveAgent(agent)
      if (!verifySync(root, target)) {
        cache.delete(target)
        return ''
      }
      let info
      try {
        info = statSync(target)
      } catch {
        return ''
      }
      const entry = cache.get(target)
      if (entry && entry.mtimeMs === info.mtimeMs && entry.size === info.size) return entry.text
      if (!entry?.refreshing) refresh(target).catch(() => {})
      return entry?.text ?? ''
    } catch {
      return ''
    }
  }

  async function prime(agent) {
    if (!config.inject) return
    try {
      const { target } = resolveAgent(agent)
      await refresh(target)
    } catch (error) {
      if (!(error instanceof Error && /live conversation workspace/.test(error.message))) {
        warnOnce('prime', error)
      }
    }
  }

  function attach(agent) {
    const id = agent?.id
    if (!id || !agent?.ctx || attached.has(id)) return
    const scoped = agent.ctx
    let dispose
    try {
      dispose = scoped.effect(() =>
        scoped.systemPrompt.context({
          name: CONTEXT_NAME,
          order: CONTEXT_ORDER,
          text: () => digestFor(agent),
        }),
      )
    } catch (error) {
      warnOnce('attach', error)
      return
    }
    attached.set(id, typeof dispose === 'function' ? dispose : () => {})
  }

  function detach(id) {
    const dispose = attached.get(id)
    if (!dispose) return
    attached.delete(id)
    try {
      dispose()
    } catch {
      // Already disposed with the agent context.
    }
  }

  // ── tools ────────────────────────────────────────────────────────────────
  /**
   * Whether this profile can persist a configuration change at all.
   *
   * Checked before asking the user: prompting them for a change that cannot be
   * written wastes their answer.
   */
  function canApplyLimits() {
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    return Boolean(entry && editor && typeof editor.edit === 'function')
  }

  /**
   * Persist a limit change through the config editor.
   *
   * Only reached after the user answered the confirmation prompt; the plugin
   * never widens or narrows a limit on its own. Editing the row restarts the
   * plugin, so the new values take effect for every session in this profile.
   */
  async function applyLimits(changes) {
    if (!canApplyLimits()) {
      throw new Error(
        'this profile cannot persist configuration; edit the workspace-memory row in the profile cordis.patch.yml by hand',
      )
    }
    const entry = ctx.fiber.entry
    const editor = ctx.get('configEditor')
    const merged = resolveConfig({ ...config, ...changes })
    const patch = {}
    for (const key of Object.keys(changes)) patch[key] = merged[key]
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
    return merged
  }

  /**
   * Ask the user through the host's question service.
   *
   * The three outcomes are kept apart on purpose: "no answerer here", "the user
   * cancelled", and "the question failed" call for different answers, and
   * folding them together told the model the feature was unavailable when the
   * user had simply declined.
   */
  async function askUser(request) {
    const service = ctx.get('userQuestions')
    if (!service || typeof service.ask !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      return { ok: true, answer: await service.ask(request) }
    } catch (error) {
      const code = String(error?.code ?? '')
      if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED' || /cancel|abort/i.test(code)) {
        return { ok: false, reason: 'cancelled', error }
      }
      warnOnce('askUser', error)
      return { ok: false, reason: 'failed', error }
    }
  }

  // Tools are registered through `ctx.inject` rather than read once at apply
  // time: at boot this row can activate before the tools service is mounted, and
  // a single `ctx.get('tools')` would then silently register nothing.
  if (config.tools) {
    ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx.tools ?? ctx.get('tools')
      if (!tools?.register) {
        warnOnce('tools', new Error('the tools service exposes no register()'))
        return
      }
      const definitions = makeTools({
        config,
        resolve: resolveAgent,
        refresh: (target) => refresh(target),
        applyLimits,
        canApplyLimits,
        askUser,
      })
      for (const definition of definitions) {
        try {
          // Owned by the plugin context, not the injected one: the tools must
          // disappear when the plugin unloads, not when the service restarts.
          ctx.effect(() => tools.register(definition))
        } catch (error) {
          warnOnce(`tool:${definition.name}`, error)
        }
      }
      logInfo(`registered ${definitions.length} tools (file=${config.memoryFile}, inject=${config.inject})`)
    })
  }

  // ── per-agent runtime context ────────────────────────────────────────────
  //
  // Listeners are installed at apply time rather than inside `ctx.inject`, so a
  // session created before the prompt service mounts is still picked up; the
  // inject callback then re-scans the live agents to cover that gap.
  if (config.inject) {
    const attachAll = () => {
      for (const agent of ctx.get('agents')?.list?.() ?? []) {
        attach(agent)
        void prime(agent)
      }
    }

    ctx.on('agent/created', async ({ agent } = {}) => {
      try {
        if (!agent) return
        await prime(agent)
        attach(agent)
      } catch (error) {
        warnOnce('agent/created', error)
      }
    })

    ctx.on('agent/disposed', ({ agent } = {}) => {
      try {
        detach(agent?.id)
      } catch {
        // Ignore.
      }
    })

    ctx.inject(['systemPrompt'], () => attachAll())
  }

  // Remove every scoped contribution if the plugin unloads while agents live.
  ctx.effect(() => () => {
    for (const id of [...attached.keys()]) detach(id)
  })
}
