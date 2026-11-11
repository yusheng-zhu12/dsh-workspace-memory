import {
  DEFAULT_PREAMBLE,
  MAX_TAGS,
  SUMMARY_MAX_CHARS,
  bodyDigest,
  demoteHeadings,
  findTopic,
  listTopics,
  lookupTitle,
  normalizeTitle,
  parseMemory,
  removeTopic,
  renderTopicBody,
  textLength,
  titleKey,
  upsertTopic,
} from './memory.js'
import { prepareTarget } from './paths.js'
import { LIMIT_MAX, resolveConfig } from './config.js'
import { redact, totalHits } from './redact.js'
import { hardReadLimitFor, readFull, readPrefix, restoreBackup, updateMemory } from './store.js'
import { formatDate } from './digest.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    error: { type: 'string' },
    topic: { type: 'string' },
    path: { type: 'string' },
    topics: { type: 'array', items: { type: 'object' } },
    created: { type: 'boolean' },
    replaced: { type: 'boolean' },
    mode: { type: 'string' },
    topicCount: { type: 'integer' },
    bytes: { type: 'integer' },
    bodyChars: { type: 'integer' },
    discardedChars: { type: 'integer' },
    redactions: { type: 'integer' },
    truncated: { type: 'boolean' },
    empty: { type: 'boolean' },
  },
  required: ['ok'],
  additionalProperties: true,
}

/**
 * Name the biggest and the oldest notes.
 *
 * A bare "it is full" leaves the model with no candidates and tempts it to
 * delete something arbitrary, so this list is reused by both the refusal and
 * `memory_limits show`.
 */
function candidateLines(doc) {
  const topics = listTopics(doc)
  if (topics.length === 0) return []

  const line = (topic) => {
    if (typeof topic.updated !== 'number' || !(topic.updated > 0)) {
      return `- "${topic.title}" — ${formatBytes(topic.bytes)}`
    }
    const date = formatDate(topic.updated)
    const age = formatAge(topic.updated)
    // formatAge falls back to the date for old notes; do not print it twice.
    const suffix = age === date ? '' : ` (${age})`
    return `- "${topic.title}" — ${formatBytes(topic.bytes)}, updated ${date}${suffix}`
  }

  const bySize = [...topics].sort((left, right) => right.bytes - left.bytes)
  const largest = bySize.slice(0, 3)
  const oldest = [...topics]
    .sort((left, right) => (left.updated ?? 0) - (right.updated ?? 0))
    .filter((topic) => !largest.includes(topic))
    .slice(0, 3)

  if (oldest.length === 0) {
    // Few notes: both lists would repeat the same lines.
    return ['Topics (largest first):', ...largest.map(line)]
  }
  return ['Largest topics:', ...largest.map(line), '', 'Oldest topics:', ...oldest.map(line)]
}

/** Explain what to do when a limit blocks a write. */
function fullHint(doc, { reason }) {
  const lines = candidateLines(doc)
  if (lines.length === 0) {
    return (
      `Workspace memory is full (${reason}), and the file has no topics to remove.\n` +
      'Trim the file by hand or raise the limit in the plugin config.'
    )
  }

  return [
    `Workspace memory is full (${reason}). Nothing was saved.`,
    '',
    ...lines,
    '',
    'Ask the user which they want, and wait for their answer: merge or delete one of these notes, ' +
      'or raise the limit (memory_limits with action "raise"). ' +
      'Do not merge, delete, or raise a limit on your own.',
  ].join('\n')
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function failure(error) {
  const message = messageOf(error)
  return { ok: false, error: message, text: `Error: ${message}` }
}

function renderText(value) {
  if (!value || typeof value !== 'object') return String(value ?? '')
  if (value.ok === false) return `Error: ${value.error ?? 'unknown error'}`
  return typeof value.text === 'string' ? value.text : ''
}

function throwIfAborted(exec) {
  if (exec?.signal?.aborted) {
    const reason = exec.signal.reason
    throw new Error(reason instanceof Error ? reason.message : 'operation aborted')
  }
  if (typeof exec?.signal?.throwIfAborted === 'function') exec.signal.throwIfAborted()
}

function shortSession(agent) {
  const id = String(agent?.id ?? '').replace(/^session-/, '')
  return id ? id.slice(0, 8) : undefined
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeDetails(value) {
  return demoteHeadings(
    String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/^\n+|\s+$/g, ''),
  )
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** One line describing the three storage limits, with correct pluralization. */
function describeLimits(config) {
  const topics = Number(config.maxTopics)
  return (
    `${topics} topic${topics === 1 ? '' : 's'}, ` +
    `${formatBytes(config.maxTopicBytes)} per note, ${formatBytes(config.maxFileBytes)} per file`
  )
}

function formatAge(time) {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return 'age unknown'
  const delta = Date.now() - time
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`
  return formatDate(time)
}

/**
 * Track which notes each conversation has actually read.
 *
 * Two properties matter:
 *  - the mark belongs to one conversation (agent), not to the whole process, so
 *    a different window cannot inherit someone else's read;
 *  - the mark is the content digest of that one note, so writing another note
 *    does not invalidate it, while a hand edit of this note does.
 */
function createReadTracker() {
  const marks = new Map()
  const keyOf = (agentId, target, title) => `${agentId ?? ''}\u0000${target}\u0000${titleKey(title)}`

  return {
    mark(agentId, target, doc, titles) {
      for (const title of titles ?? []) {
        const topic = findTopic(doc, title)
        if (!topic) continue
        marks.set(keyOf(agentId, target, topic.title), bodyDigest(topic))
      }
    },
    isFresh(agentId, target, doc, title) {
      const topic = findTopic(doc, title)
      if (!topic) return false
      const mark = marks.get(keyOf(agentId, target, topic.title))
      return Boolean(mark) && mark === bodyDigest(topic)
    },
    forget(agentId, target, titles) {
      for (const title of titles ?? []) marks.delete(keyOf(agentId, target, title))
    },
    forgetAll(agentId, target) {
      const prefix = `${agentId ?? ''}\u0000${target}\u0000`
      for (const key of [...marks.keys()]) if (key.startsWith(prefix)) marks.delete(key)
    },
  }
}

/**
 * Build the six model-facing tools.
 *
 * `resolve(agent)` returns `{ root, target }` for the agent's workspace and
 * throws a user-readable error when the agent has no workspace.
 * `refresh(target)` pulls the new contents into the prompt-context cache.
 */
export function makeTools({ config, resolve, refresh, applyLimits, canApplyLimits, askUser }) {
  const output = {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: renderText(value) }],
  }
  const reads = createReadTracker()
  const backupPathFor = (target) => (config.backup ? `${target}.bak` : undefined)

  /**
   * Refuse a title that looks like it carries a secret.
   *
   * The error names the rule that matched, never the redacted title: echoing it
   * would put the surviving prefix into the tool result and the session log.
   */
  function safeTitle(raw) {
    const title = normalizeTitle(raw)
    if (!config.redact) return title
    const result = redact(title)
    if (result.text !== title) {
      const rules = result.hits.map((hit) => hit.name).join(', ')
      throw new Error(
        'topic contains something that looks like a secret; remove it and retry' +
          (rules ? ` (matched: ${rules})` : ''),
      )
    }
    return title
  }

  const saveTool = {
    name: 'memory_save',
    description:
      'Save a durable note for this workspace, visible to later conversations in the same workspace. ' +
      'Use it after analyzing code when the conclusions (architecture, key files, invariants, gotchas) ' +
      'would save a future conversation real work. The workspace index shows only each note\'s summary, ' +
      'so read an existing note before rewriting it. Never record credentials or secrets.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            "Stable short title, at most 120 characters, for example 'auth: token refresh'. " +
            'An existing title updates that note instead of adding a duplicate.',
        },
        summary: {
          type: 'string',
          description:
            'One or two sentences a future reader can scan; this is what the workspace index shows. ' +
            'Write it to cover the whole note, including anything append kept from earlier.',
        },
        details: {
          type: 'string',
          description:
            'Markdown details: key files, data flow, invariants, gotchas, open questions. Keep it self-contained and concise. ' +
            'With mode replace the note body becomes exactly this text, so anything omitted is lost. ' +
            'Use ### or lower for subheadings; ## is reserved for topic titles and is demoted automatically.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional short labels for scanning, at most 8, each truncated to 32 characters, for example ["auth", "backend"].',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description:
            'Decide for this save. append keeps the existing body and adds details after it, and replaces the summary; ' +
            'use it when adding findings to a note that already exists. replace makes the body exactly details and ' +
            'discards the previous body; use it only when rewriting the whole note from scratch. ' +
            'Either value creates a new topic.',
        },
      },
      required: ['topic', 'summary', 'mode'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        throwIfAborted(exec)
        const title = safeTitle(args?.topic)
        let summary = oneLine(args?.summary)
        if (!summary) throw new Error('summary must not be empty')
        let details = normalizeDetails(args?.details)
        const mode = args?.mode
        if (mode !== 'replace' && mode !== 'append') {
          throw new Error(
            "mode is required: use 'append' to add findings to an existing note, or 'replace' to rewrite it",
          )
        }
        if (Buffer.byteLength(details, 'utf8') > config.maxTopicBytes) {
          throw new Error(`details must be at most ${config.maxTopicBytes} bytes`)
        }

        let redactions = 0
        let tags = []
        if (config.redact) {
          const redactedSummary = redact(summary)
          const redactedDetails = redact(details)
          summary = redactedSummary.text
          details = redactedDetails.text
          redactions = totalHits(redactedSummary.hits) + totalHits(redactedDetails.hits)
        }
        // Redact before truncating: cutting a token to 32 characters first would
        // leave a prefix that no longer matches any rule.
        const seen = new Set()
        for (const item of Array.isArray(args?.tags) ? args.tags : []) {
          let tag = oneLine(item)
          if (!tag) continue
          if (config.redact) {
            const redactedTag = redact(tag)
            tag = redactedTag.text
            redactions += totalHits(redactedTag.hits)
          }
          tag = tag.slice(0, 32)
          const key = tag.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          tags.push(tag)
          if (tags.length >= MAX_TAGS) break
        }
        if (summary.length > SUMMARY_MAX_CHARS) {
          throw new Error(`summary must be at most ${SUMMARY_MAX_CHARS} characters`)
        }

        const agentId = exec?.agent?.id
        const { root, target } = resolve(exec?.agent)
        await prepareTarget(root, target, { create: true })

        const outcome = await updateMemory(target, {
          maxBytes: config.maxFileBytes,
          backupPath: backupPathFor(target),
          onOverflow: ({ doc }) =>
            fullHint(doc, {
              reason: `the file would grow past maxFileBytes (${config.maxFileBytes} bytes)`,
            }),
          mutate: (doc) => {
            const seeded = String(doc?.preamble ?? '').trim() ? doc : { ...doc, preamble: DEFAULT_PREAMBLE }
            // The gate lives inside the lock so the decision cannot be made
            // against content another write replaced in the meantime.
            if (config.requireReadBeforeReplace && mode === 'replace') {
              const existing = findTopic(seeded, title)
              if (existing && !reads.isFresh(agentId, target, seeded, existing.title)) {
                throw new Error(
                  `"${existing.title}" already exists and has not been read in this conversation, so replacing it ` +
                    `would overwrite content you have not seen. Call memory_read with topic "${existing.title}" first, ` +
                    "then save with mode 'replace' (or use mode 'append' to add to it).",
                )
              }
            }
            // Check the cap here rather than inside upsertTopic so the refusal
            // can name candidate topics.
            if (!findTopic(seeded, title) && seeded.topics.length >= config.maxTopics) {
              throw new Error(
                fullHint(seeded, { reason: `it already holds ${seeded.topics.length} topics, the maxTopics limit` }),
              )
            }
            return upsertTopic(seeded, {
              title,
              summary,
              details,
              tags,
              mode,
              session: shortSession(exec?.agent),
              now: Date.now(),
              maxTopics: config.maxTopics,
              maxBodyBytes: config.maxTopicBytes,
            })
          },
        })
        // The writer authored this body, so it counts as read for this
        // conversation; otherwise a follow-up replace would be refused.
        reads.mark(agentId, target, outcome.doc, [outcome.topic.title])
        await refresh?.(target)

        const total = outcome.doc.topics.length
        const verb = outcome.created ? 'Created' : 'Updated'
        const note = redactions > 0 ? ` ${redactions} secret-like value(s) redacted.` : ''
        const previousChars = outcome.previous?.bodyChars ?? 0
        const bodyChars = textLength(outcome.topic.body)
        const discardedChars = outcome.replaced && !outcome.keptBody ? previousChars : 0
        let warning = ''
        if (discardedChars > 200 && bodyChars < discardedChars * 0.6) {
          warning =
            ` Warning: replace discarded ${discardedChars} characters of previous details and the note is now ${bodyChars}; ` +
            "the old body is gone. Use mode 'append' next time, or re-save the complete body."
        }
        const how = outcome.created
          ? ''
          : outcome.keptBody
            ? ' (appended; previous details kept)'
            : ` (replaced; ${discardedChars} characters of previous details discarded)`
        return {
          ok: true,
          text: `${verb} "${outcome.topic.title}" — ${total} topic${total === 1 ? '' : 's'}, ${formatBytes(outcome.bytes)} at ${target}.${how}${note}${warning}`,
          topic: outcome.topic.title,
          path: target,
          created: outcome.created,
          replaced: outcome.replaced,
          mode,
          topicCount: total,
          bytes: outcome.bytes,
          bodyChars,
          discardedChars,
          redactions,
        }
      } catch (error) {
        return failure(error)
      }
    },
  }

  const readTool = {
    name: 'memory_read',
    description:
      "Read this workspace's memory. The index shows only summaries; with topic this returns that note's full text, " +
      'and without it the whole memory file (truncated when large). Read an existing note before rewriting it.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Exact topic title from the memory index or memory_list. Omit to read the whole file.',
        },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        throwIfAborted(exec)
        const agentId = exec?.agent?.id
        const { root, target } = resolve(exec?.agent)
        const prepared = await prepareTarget(root, target, { create: false })
        if (!prepared) {
          return { ok: true, empty: true, path: target, text: `No workspace memory yet at ${target}.` }
        }

        const requested = args?.topic === undefined || args?.topic === null ? '' : String(args.topic).trim()
        if (requested) {
          const title = lookupTitle(requested)
          const raw = await readFull(target, config.maxFileBytes, { hardMaxBytes: hardReadLimitFor(config.maxFileBytes) })
          const doc = parseMemory(raw ?? '')
          const topic = findTopic(doc, title)
          if (!topic) {
            return {
              ok: false,
              error: `no topic named "${title}"`,
              text: `Error: no topic named "${title}". Use memory_list to see available topics.`,
            }
          }
          reads.mark(agentId, target, doc, [topic.title])
          const body = renderTopicBody(topic)
          return {
            ok: true,
            topic: topic.title,
            path: target,
            text: body || `(the note "${topic.title}" is empty)`,
          }
        }

        const { text: raw, truncated, size } = await readPrefix(target, config.maxReadChars * 4)
        const clipped = truncated || raw.length > config.maxReadChars
        const text = clipped
          ? `${raw.slice(0, config.maxReadChars)}\n\n[truncated; use memory_read with a topic for one note]`
          : raw
        if (!clipped) {
          const doc = parseMemory(raw)
          reads.mark(
            agentId,
            target,
            doc,
            doc.topics.map((topic) => topic.title),
          )
        }
        return {
          ok: true,
          path: target,
          truncated: clipped,
          bytes: size,
          text: text || '(the workspace memory file is empty)',
        }
      } catch (error) {
        return failure(error)
      }
    },
  }

  const listTool = {
    name: 'memory_list',
    description:
      "List this workspace's memory topics with summaries and sizes, without reading the full file.",
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output,
    async execute(_args, exec) {
      try {
        throwIfAborted(exec)
        const { root, target } = resolve(exec?.agent)
        const prepared = await prepareTarget(root, target, { create: false })
        if (!prepared) {
          return { ok: true, empty: true, topics: [], path: target, text: `No workspace memory yet at ${target}.` }
        }
        const raw = await readFull(target, config.maxFileBytes, { hardMaxBytes: hardReadLimitFor(config.maxFileBytes) })
        const doc = parseMemory(raw ?? '')
        const topics = listTopics(doc).sort(
          (left, right) => (right.updated ?? 0) - (left.updated ?? 0) || left.title.localeCompare(right.title),
        )
        if (topics.length === 0) {
          return { ok: true, topics: [], path: target, text: `No topics yet in ${target}.` }
        }
        const latest = topics.reduce((max, topic) => Math.max(max, topic.updated ?? 0), 0)
        const lines = topics.map(
          (topic) =>
            `- ${topic.title} — ${topic.summary || '(no summary)'} (${formatAge(topic.updated)}, ${formatBytes(topic.bytes)})`,
        )
        const count = topics.length
        return {
          ok: true,
          path: target,
          topics,
          text: `${count} topic${count === 1 ? '' : 's'} in ${target} (updated ${formatDate(latest)}):\n${lines.join('\n')}`,
        }
      } catch (error) {
        return failure(error)
      }
    },
  }

  const forgetTool = {
    name: 'memory_forget',
    description:
      "Delete one topic from this workspace's memory. The deletion cannot be undone, but memory_restore " +
      'can roll the whole file back one step.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Exact topic title to delete.' },
        confirm: {
          type: 'boolean',
          description: 'Must be true; guards against accidental deletion.',
        },
      },
      required: ['topic', 'confirm'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        throwIfAborted(exec)
        if (args?.confirm !== true) throw new Error('confirm must be true to delete a topic')
        const title = lookupTitle(args?.topic)
        const agentId = exec?.agent?.id
        const { root, target } = resolve(exec?.agent)
        const prepared = await prepareTarget(root, target, { create: false })
        if (!prepared) throw new Error('no workspace memory to delete from')

        const outcome = await updateMemory(target, {
          maxBytes: config.maxFileBytes,
          backupPath: backupPathFor(target),
          mutate: (doc) => {
            const result = removeTopic(doc, title)
            if (!result) throw new Error(`no topic named "${title}"`)
            return { doc: result.doc, removedTitle: result.removed.title }
          },
        })
        reads.forget(agentId, target, [outcome.removedTitle])
        await refresh?.(target)

        const remaining = outcome.doc.topics.length
        return {
          ok: true,
          topic: outcome.removedTitle,
          path: target,
          topicCount: remaining,
          text: `Removed "${outcome.removedTitle}". ${remaining} topic${remaining === 1 ? '' : 's'} ${remaining === 1 ? 'remains' : 'remain'}.`,
        }
      } catch (error) {
        return failure(error)
      }
    },
  }

  const restoreTool = {
    name: 'memory_restore',
    description:
      'Restore this workspace memory from the single backup kept before the most recent modification. ' +
      'Use it when a note was overwritten or deleted by mistake. The backup is not consumed, so this can be retried, ' +
      'but the file it replaces cannot be recovered afterwards.',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be true; restoring replaces the current memory file.',
        },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        throwIfAborted(exec)
        if (args?.confirm !== true) throw new Error('confirm must be true to restore the memory file')
        if (!config.backup) throw new Error('backups are disabled by config (backup: false)')
        const agentId = exec?.agent?.id
        const { root, target } = resolve(exec?.agent)
        await prepareTarget(root, target, { create: true })
        const backupPath = backupPathFor(target)
        // Refuse a backup that is a symlink or resolves outside the workspace:
        // restore would otherwise copy an arbitrary file into the memory file.
        const safeBackup = await prepareTarget(root, backupPath, { create: false })
        if (!safeBackup) throw new Error('no backup yet; one is written before every modification')
        const previous = await restoreBackup(target, backupPath, {
          maxBytes: config.maxFileBytes,
          hardMaxBytes: hardReadLimitFor(config.maxFileBytes),
        })
        const doc = parseMemory(previous)
        reads.forgetAll(agentId, target)
        await refresh?.(target)

        const count = doc.topics.length
        return {
          ok: true,
          path: target,
          topicCount: count,
          bytes: Buffer.byteLength(previous, 'utf8'),
          text:
            `Restored from ${backupPath}: ${count} topic${count === 1 ? '' : 's'}, ` +
            `${formatBytes(Buffer.byteLength(previous, 'utf8'))}. The backup itself is unchanged.`,
        }
      } catch (error) {
        return failure(error)
      }
    },
  }

  const limitsTool = {
    name: 'memory_limits',
    description:
      'Report the workspace memory limits and how full the file is, or change a limit. ' +
      'Changing a limit asks the user for confirmation. raise only grows a cap and must leave room ' +
      'above what is already stored; set may also lower it, but never below what is stored.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'raise', 'set'],
          description:
            'show (default) reports limits and usage; raise grows a cap; set applies any value after asking the user.',
        },
        maxTopics: { type: 'number', description: 'New topic cap, 1-10000 (integer).' },
        maxTopicBytes: {
          type: 'number',
          description: 'New per-note cap in bytes, 256-4194304 (integer).',
        },
        maxFileBytes: {
          type: 'number',
          description: 'New whole-file cap in bytes, 1024-67108864 (integer).',
        },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        throwIfAborted(exec)
        const action = args?.action ?? 'show'
        if (action !== 'show' && action !== 'raise' && action !== 'set') {
          throw new Error("action must be 'show', 'raise' or 'set'")
        }

        const current = describeLimits(config)
        const { root, target } = resolve(exec?.agent)

        if (action === 'show') {
          const prepared = await prepareTarget(root, target, { create: false })
          let usage = 'no memory file yet'
          let candidates = ''
          let nearFull = ''
          if (prepared) {
            // Read past the configured cap: a file that is already over it must
            // still be counted in full, or `show` would under-report the topics
            // it is asking the user to choose between.
            const raw = await readPrefix(target, hardReadLimitFor(config.maxFileBytes))
            const doc = parseMemory(raw.text)
            const percent = Math.round((raw.size / config.maxFileBytes) * 100)
            const share = percent === 0 && raw.size > 0 ? '<1' : String(percent)
            const counted = raw.truncated
              ? `at least ${doc.topics.length} topics`
              : `${doc.topics.length} topic${doc.topics.length === 1 ? '' : 's'}`
            usage = `${counted}, ${formatBytes(raw.size)} (${share}% of the file cap)`
            const lines = candidateLines(doc)
            if (lines.length > 0) {
              const partial = raw.truncated ? '\n(the file is larger than the read limit; this list is partial)' : ''
              candidates = `\n\n${lines.join('\n')}${partial}`
            }
            const topicsShare = doc.topics.length / config.maxTopics
            if (percent >= 80 || topicsShare >= 0.8) {
              nearFull = '\n\nThe memory is close to its limit; tell the user before adding much more.'
            }
          }
          return {
            ok: true,
            path: target,
            text: `Workspace memory limits: ${current}.\nNow: ${usage}.${candidates}${nearFull}`,
          }
        }

        const changes = {}
        for (const key of ['maxTopics', 'maxTopicBytes', 'maxFileBytes']) {
          if (args?.[key] === undefined) continue
          changes[key] = args[key]
        }
        if (Object.keys(changes).length === 0) {
          throw new Error('name at least one of maxTopics, maxTopicBytes, maxFileBytes')
        }
        for (const [key, value] of Object.entries(changes)) {
          if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`)
        }

        if (action === 'raise') {
          // `raise` only ever grows: lowering a cap turns the workspace
          // read-only while the result still says it was raised.
          for (const [key, value] of Object.entries(changes)) {
            if (value < config[key]) {
              throw new Error(
                `${key} can only be raised: it is ${config[key]} and ${value} was requested. ` +
                  "Lowering a limit needs action 'set'.",
              )
            }
          }
        }

        // Validate against the ceilings before asking, so the user is never
        // prompted for a value that cannot be applied.
        const next = resolveConfig({ ...config, ...changes })

        // A cap below what is already stored would lock existing notes: they
        // could be read but never updated again. `raise` is held to the same
        // floor — otherwise "raise the limit" can leave the file still over its
        // cap and the user no better off.
        const prepared = await prepareTarget(root, target, { create: false })
        let usage = null
        if (prepared) {
          // Read past the configured cap: a file that is already over it must
          // still be counted in full, or the floor would be far too low.
          const raw = await readPrefix(target, hardReadLimitFor(config.maxFileBytes))
          if (raw.truncated) {
            // The counts would come from a prefix, so any floor derived from
            // them could be too low — refuse rather than guess.
            throw new Error(
              'the memory file is larger than the read limit, so its usage cannot be counted; ' +
                'shrink the file by hand before changing a limit',
            )
          }
          const doc = parseMemory(raw.text)
          const largestNote = doc.topics.reduce(
            (max, topic) => Math.max(max, Buffer.byteLength(`## ${topic.title}\n${topic.body}\n`, 'utf8')),
            0,
          )
          usage = {
            maxTopics: doc.topics.length,
            maxFileBytes: raw.size,
            maxTopicBytes: largestNote,
          }
        }

        if (Object.entries(changes).every(([key, value]) => value === config[key])) {
          const stuck = action === 'raise' && usage ? Object.keys(changes).filter((key) => config[key] <= usage[key]) : []
          if (stuck.length > 0) {
            const detail = stuck.map((key) => `${key} is ${config[key]} with ${usage[key]} already stored`).join('; ')
            return {
              ok: true,
              path: target,
              text:
                `The workspace memory limits are already ${current}; nothing changed. ` +
                `That leaves no room (${detail}) — raise above the stored usage to make space.`,
            }
          }
          return { ok: true, path: target, text: `The workspace memory limits are already ${current}; nothing changed.` }
        }

        if (usage) {
          const labels = {
            maxTopics: 'topics already stored',
            maxFileBytes: 'bytes already stored',
            maxTopicBytes: 'bytes in the largest note',
          }
          for (const [key, used] of Object.entries(usage)) {
            if (changes[key] === undefined) continue
            // `set` may freeze the current usage exactly; `raise` exists to make
            // room, so a cap that merely equals what is stored leaves no room
            // and the "full" prompt would simply return next time.
            const minimum = action === 'raise' ? used + 1 : used
            if (changes[key] >= minimum) continue
            const label = labels[key]
            if (action === 'raise') {
              const ceiling = LIMIT_MAX[key]
              if (used >= ceiling) {
                throw new Error(
                  `${key} cannot be raised to ${changes[key]}: there are ${used} ${label}, and ${ceiling} is the maximum. ` +
                    "Shrink the memory, or use action 'set' with a value that still fits.",
                )
              }
              throw new Error(
                `${key} cannot be raised to ${changes[key]}: there are ${used} ${label}. ` +
                  `Raise it above ${used} (for example ${Math.min(used + 1, ceiling)}) to leave room, ` +
                  "or use action 'set' after shrinking the memory.",
              )
            }
            throw new Error(
              `${key} cannot be set to ${changes[key]}: there are ${used} ${label}. ` +
                'Shrink the memory first, or pick a larger value.',
            )
          }
        }

        // Fail before asking when the change could not be written anyway: an
        // answer the plugin cannot act on is worse than a clear refusal.
        if (typeof canApplyLimits === 'function' && !canApplyLimits()) {
          throw new Error(
            'this profile cannot persist configuration; edit the workspace-memory row in the profile cordis.patch.yml by hand',
          )
        }

        const verb = action === 'set' ? 'Apply' : 'Raise'
        const questionId = 'memory-limits'
        // The decision belongs to the user, so ask them through the host rather
        // than trusting a `confirm` flag the model fills in itself.
        const asked = await askUser({
          agent: exec?.agent,
          signal: exec?.signal,
          questions: [
            {
              id: questionId,
              header: 'Memory limits',
              question: `${verb} the workspace memory limits?`,
              detail: `Now: ${current}\n` + `New: ${describeLimits(next)}`,
              options: [
                { label: verb, description: 'Apply the new limits for every session in this profile.' },
                { label: 'Cancel', description: 'Keep the current limits.' },
              ],
            },
          ],
        })
        if (!asked?.ok) {
          if (asked?.reason === 'cancelled') {
            return { ok: true, path: target, text: 'The user cancelled; the limits are unchanged.' }
          }
          if (asked?.reason === 'failed') {
            const reason = asked.error instanceof Error ? asked.error.message : String(asked.error ?? 'unknown error')
            throw new Error(`asking the user failed (${reason}); the limits are unchanged`)
          }
          throw new Error(
            'the user cannot be asked from this context, so the limits were left unchanged; ' +
              'ask the user in the conversation and let them edit the workspace-memory config row',
          )
        }
        const choice = (asked.answer?.answers ?? []).find((item) => item?.id === questionId)?.selected?.[0]
        if (choice !== verb) {
          return { ok: true, path: target, text: 'The user declined; the limits are unchanged.' }
        }

        const applied = await applyLimits(changes)
        return {
          ok: true,
          path: target,
          text: `${action === 'set' ? 'Set' : 'Raised'} the workspace memory limits to ${describeLimits(applied)}. The plugin reloads with the new values.`,
        }
      } catch (error) {
        return failure(error)
      }
    },
  }

  return [saveTool, readTool, listTool, forgetTool, restoreTool, limitsTool]
}
