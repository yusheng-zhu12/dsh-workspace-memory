/**
 * Pure Markdown memory model.
 *
 * The file is the source of truth and is meant to be read and edited by hand.
 * Nothing here touches the filesystem, so every rule below is testable without
 * a host or a temporary directory.
 *
 * Layout:
 *
 *   # Workspace memory            <- preamble (kept verbatim)
 *   <!-- optional notes -->
 *
 *   ## topic title                <- one topic per level-2 heading
 *   <!-- dsh-memory: {...} -->    <- optional metadata line
 *   **Summary:** one line
 *
 *   details in Markdown
 *
 * Everything a hand edit adds that is not understood stays in the document.
 */

import { createHash } from 'node:crypto'

const META_RE = /^\s*<!--\s*dsh-memory:\s*(\{[\s\S]*?\})\s*-->\s*$/
const H2_RE = /^##[ \t]+(.+?)[ \t]*$/
const SUMMARY_RE = /^\s*\*\*Summary:\*\*\s*(.*)$/i
const SUMMARY_ALT_RE = /^\s*Summary:\s*(.*)$/i

export const TOPIC_MAX_CHARS = 120
export const SUMMARY_MAX_CHARS = 400
export const DIGEST_SUMMARY_CHARS = 160
export const MAX_TAGS = 8

/** Header written when a workspace starts its memory file. */
export const DEFAULT_PREAMBLE = `# Workspace memory

<!-- Shared notes for this workspace. Written by DeepSeek Harness conversations; edit by hand if useful. -->`

/** Normalize line endings and drop a UTF-8 BOM. */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
}

/** Collapse a title to one line and strip leading heading marks. */
export function cleanTitle(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .trim()
}

/** Validate a model-supplied topic title. Throws with an actionable message. */
export function normalizeTitle(value) {
  const title = cleanTitle(value)
  if (!title) throw new Error('topic must not be empty')
  if (title.length > TOPIC_MAX_CHARS) {
    throw new Error(`topic must be at most ${TOPIC_MAX_CHARS} characters`)
  }
  return title
}

/**
 * Validate a title used to *find* an existing topic.
 *
 * Hand-written files may hold headings longer than the write limit; refusing to
 * look them up — or truncating the request — would make such a topic readable
 * only as the whole file and impossible to delete.
 */
export function lookupTitle(value) {
  const title = cleanTitle(value)
  if (!title) throw new Error('topic must not be empty')
  return title
}

/** Stable comparison key for "same topic". */
export function titleKey(title) {
  return cleanTitle(title).toLowerCase()
}

function clip(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function stripMarkdownInline(value) {
  return String(value ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^[-+]\s+/, '')
    .trim()
}

function toTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractMeta(lines) {
  let cursor = 0
  while (cursor < lines.length && lines[cursor].trim() === '') cursor++
  if (cursor >= lines.length) return { meta: null, lines: [] }
  const match = META_RE.exec(lines[cursor])
  if (!match) return { meta: null, lines }
  let meta = null
  try {
    const parsed = JSON.parse(match[1])
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed
  } catch {
    // A malformed metadata comment is just text; never drop the topic.
    return { meta: null, lines }
  }
  return { meta, lines: [...lines.slice(0, cursor), ...lines.slice(cursor + 1)] }
}

function summarize(body) {
  const lines = body.split('\n')
  for (const line of lines) {
    const match = SUMMARY_RE.exec(line) ?? SUMMARY_ALT_RE.exec(line)
    if (match) return clip(stripMarkdownInline(match[1]), DIGEST_SUMMARY_CHARS)
  }
  for (const line of lines) {
    const text = line.trim()
    if (!text || text.startsWith('#') || text.startsWith('<!--')) continue
    return clip(stripMarkdownInline(text), DIGEST_SUMMARY_CHARS)
  }
  return ''
}

function makeTopic(title, body, meta) {
  const tags = Array.isArray(meta?.tags)
    ? meta.tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, MAX_TAGS)
    : []
  return {
    title,
    body,
    meta,
    summary: summarize(body),
    updated: toTime(meta?.updated),
    tags,
  }
}

/**
 * Mark the lines a Markdown reader would not treat as headings: fenced code
 * blocks and HTML comments. A hand-edited file may keep an old `##` inside a
 * comment or show `##` in an example, and rewriting it as a real topic would
 * silently move text out of the comment.
 */
function maskedLines(lines) {
  const masked = new Array(lines.length).fill(false)
  let fence = null
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (fence) {
      masked[index] = true
      const close = new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`)
      if (close.test(line)) fence = null
      index++
      continue
    }
    const openFence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (openFence) {
      masked[index] = true
      fence = { char: openFence[1][0], length: openFence[1].length }
      index++
      continue
    }
    // Only a comment that starts its own line opens a block, and only a closed
    // one masks anything. An inline `<!--` — as in `## topic <!-- note -->` —
    // is ordinary text, and a stray unterminated `<!--` must not be able to
    // hide every heading after it.
    const openComment = /^\s*<!--/.exec(line)
    if (openComment) {
      const from = line.indexOf('<!--') + 4
      const end = findCommentEnd(lines, index, from)
      if (end !== -1) {
        for (let cursor = index; cursor <= end; cursor++) masked[cursor] = true
        index = end + 1
        continue
      }
    }
    index++
  }
  return masked
}

/** Index of the line closing a comment opened on `fromIndex`, or -1. */
function findCommentEnd(lines, fromIndex, fromColumn) {
  for (let index = fromIndex; index < lines.length; index++) {
    const from = index === fromIndex ? fromColumn : 0
    if (lines[index].indexOf('-->', from) >= 0) return index
  }
  return -1
}

/** Parse a memory file into a preamble plus ordered topics. Never throws. */
export function parseMemory(raw) {
  const text = normalizeText(raw)
  const lines = text.split('\n')
  const masked = maskedLines(lines)
  const headings = []
  for (let index = 0; index < lines.length; index++) {
    if (masked[index]) continue
    const match = H2_RE.exec(lines[index])
    if (!match) continue
    const title = cleanTitle(match[1])
    if (title) headings.push({ index, title })
  }

  const preambleSource = headings.length ? lines.slice(0, headings[0].index) : lines
  const preamble = preambleSource.join('\n').replace(/^\n+|\s+$/g, '')

  const topics = []
  for (let position = 0; position < headings.length; position++) {
    const heading = headings[position]
    const end = position + 1 < headings.length ? headings[position + 1].index : lines.length
    const { meta, lines: bodyLines } = extractMeta(lines.slice(heading.index + 1, end))
    const body = bodyLines.join('\n').replace(/^\n+|\s+$/g, '')
    topics.push(makeTopic(heading.title, body, meta))
  }

  return { preamble, topics }
}

/** Stable serialization. Parsing the result returns an equivalent document. */
export function renderMemory(doc) {
  const blocks = []
  const preamble = String(doc?.preamble ?? '').replace(/^\n+|\s+$/g, '')
  if (preamble) blocks.push(preamble)
  for (const topic of doc?.topics ?? []) {
    const title = cleanTitle(topic?.title)
    if (!title) continue
    const body = String(topic?.body ?? '').replace(/^\n+|\s+$/g, '')
    const meta = topic?.meta && typeof topic.meta === 'object' ? `<!-- dsh-memory: ${serializeMeta(topic.meta)} -->` : ''
    const content = [meta, body].filter(Boolean).join('\n')
    blocks.push(content ? `## ${title}\n${content}` : `## ${title}`)
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : ''
}

function serializeMeta(meta) {
  return JSON.stringify(meta).replace(/-->/g, '--\\u003e')
}

function bodyWithoutSummary(body) {
  const lines = String(body ?? '').split('\n')
  const index = lines.findIndex((line) => SUMMARY_RE.test(line) || SUMMARY_ALT_RE.test(line))
  if (index >= 0) lines.splice(index, 1)
  return lines.join('\n').replace(/^\n+|\s+$/g, '')
}

/**
 * Keep level-2 headings reserved for topic titles.
 *
 * Models naturally write `##` subheadings inside a note. Left alone, those
 * would split one note into several topics on the next parse, so a level-2
 * line in details is demoted to level 3.
 */
export function demoteHeadings(value) {
  return String(value ?? '').replace(/^##(?!#)([ \t]+)/gm, '###$1')
}

function metaObject({ tags, session, now }) {
  const meta = { v: 1, updated: new Date(now).toISOString() }
  if (session) meta.session = String(session)
  if (Array.isArray(tags) && tags.length) meta.tags = tags
  return meta
}

function topicBody({ summary, details }) {
  const lines = [`**Summary:** ${summary}`]
  const body = String(details ?? '').replace(/^\n+|\s+$/g, '')
  if (body) lines.push('', body)
  return lines.join('\n')
}

/**
 * Create or update one topic.
 *
 * `mode: 'replace'` (default) rewrites the body from `details`.
 * `mode: 'append'` keeps the existing body, replaces the summary and appends
 * the new details, so a later session can add a gotcha without re-sending the
 * whole note.
 */
export function upsertTopic(doc, options) {
  const {
    title: rawTitle,
    summary: rawSummary,
    details = '',
    tags,
    mode = 'replace',
    session,
    now = Date.now(),
    maxTopics = 100,
    maxBodyBytes = 16384,
  } = options ?? {}

  const title = normalizeTitle(rawTitle)
  if (mode !== 'replace' && mode !== 'append') {
    throw new Error("mode must be 'replace' or 'append'")
  }
  const summary = String(rawSummary ?? '').replace(/\s+/g, ' ').trim()
  if (!summary) throw new Error('summary must not be empty')
  if (summary.length > SUMMARY_MAX_CHARS) {
    throw new Error(`summary must be at most ${SUMMARY_MAX_CHARS} characters`)
  }

  const key = titleKey(title)
  const index = (doc?.topics ?? []).findIndex((topic) => titleKey(topic.title) === key)
  const existing = index >= 0 ? doc.topics[index] : undefined
  if (!existing && (doc?.topics?.length ?? 0) >= maxTopics) {
    throw new Error(`memory already has ${maxTopics} topics; update or forget one before adding another`)
  }

  const effectiveTags = Array.isArray(tags) && tags.length ? tags : existing?.tags ?? []
  const normalizedDetails = demoteHeadings(details)
  const effectiveDetails =
    mode === 'append' && existing
      ? [bodyWithoutSummary(existing.body), String(normalizedDetails ?? '').trim()].filter(Boolean).join('\n\n')
      : normalizedDetails

  if (Buffer.byteLength(String(effectiveDetails ?? ''), 'utf8') > maxBodyBytes) {
    throw new Error(`details must be at most ${maxBodyBytes} bytes`)
  }

  const content = topicBody({ summary, details: effectiveDetails })
  const nextTopic = makeTopic(
    existing ? existing.title : title,
    content,
    metaObject({ tags: effectiveTags, session, now }),
  )

  const topics = [...(doc?.topics ?? [])]
  if (existing) topics[index] = nextTopic
  else topics.push(nextTopic)

  return {
    doc: { preamble: doc?.preamble ?? '', topics },
    topic: nextTopic,
    created: !existing,
    replaced: Boolean(existing),
    previous: existing
      ? {
          summary: existing.summary,
          bodyBytes: Buffer.byteLength(existing.body, 'utf8'),
          bodyChars: textLength(existing.body),
          updated: existing.updated,
        }
      : null,
    keptBody: Boolean(existing) && mode === 'append',
  }
}

/** Count characters as a reader would, not UTF-16 code units. */
export function textLength(value) {
  return Array.from(String(value ?? '')).length
}

/**
 * Content identity of one topic.
 *
 * The read gate compares this instead of a file signature: writing topic A must
 * not invalidate the mark for topic B, while a hand edit of B must.
 */
export function bodyDigest(topic) {
  return createHash('sha1').update(String(topic?.body ?? ''), 'utf8').digest('hex')
}

export function findTopic(doc, title) {
  const key = titleKey(title)
  return (doc?.topics ?? []).find((topic) => titleKey(topic.title) === key)
}

export function removeTopic(doc, title) {
  const key = titleKey(title)
  const index = (doc?.topics ?? []).findIndex((topic) => titleKey(topic.title) === key)
  if (index < 0) return null
  const topics = [...doc.topics]
  const [removed] = topics.splice(index, 1)
  return { doc: { preamble: doc?.preamble ?? '', topics }, removed }
}

/** Topic bodies as written, without the metadata comment. */
export function renderTopicBody(topic) {
  return String(topic?.body ?? '').replace(/^\n+|\s+$/g, '')
}

export function listTopics(doc) {
  return (doc?.topics ?? []).map((topic) => ({
    title: topic.title,
    summary: topic.summary,
    updated: topic.updated,
    tags: topic.tags,
    bytes: Buffer.byteLength(`## ${topic.title}\n${topic.body}\n`, 'utf8'),
  }))
}

export function latestUpdated(doc) {
  let latest = 0
  for (const topic of doc?.topics ?? []) {
    if (typeof topic.updated === 'number' && topic.updated > latest) latest = topic.updated
  }
  return latest
}

export { clip }
