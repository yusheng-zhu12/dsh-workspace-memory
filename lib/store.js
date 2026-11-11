import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { parseMemory, renderMemory } from './memory.js'

/**
 * Filesystem layer for the memory file.
 *
 * Writes are serialized per target path inside this process and committed with
 * a temporary file plus rename, so a reader never sees a half-written document
 * and a crash leaves either the old file or the new one.
 */

const queues = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run `fn` after every earlier operation on the same key has settled. */
export function withPathLock(key, fn) {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  const settled = next.catch(() => {})
  queues.set(key, settled)
  settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}

/**
 * Absolute ceiling for reading a file that is already over `maxFileBytes`.
 *
 * A file can grow past the configured cap through a hand edit or an older
 * configuration. Refusing to read it at all would make every write tool fail —
 * including the `memory_forget` that the error message suggests — so reads are
 * allowed up to this ceiling and the *result* is checked against the cap.
 */
export const HARD_READ_LIMIT = 8 * 1024 * 1024

/**
 * How much may be read to repair or rewrite a file capped at `maxBytes`.
 *
 * The fixed floor covers a default-sized file; a deployment that raises
 * `maxFileBytes` gets room for a file that is already over its own cap.
 */
export function hardReadLimitFor(maxBytes) {
  return Math.max(HARD_READ_LIMIT, Number(maxBytes) * 2 || 0)
}

/**
 * Read a whole file.
 *
 * `maxBytes` is the size the caller will accept for the document it is about to
 * write; `hardMaxBytes` bounds how much may be read to get there.
 */
export async function readFull(target, maxBytes, { hardMaxBytes = maxBytes } = {}) {
  let info
  try {
    info = await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile()) throw new Error(`not a regular file: ${target}`)
  if (info.size > hardMaxBytes) {
    throw new Error(
      `memory file is ${info.size} bytes, above the ${hardMaxBytes}-byte hard read limit; ` +
        'trim the file by hand, or restore the previous version',
    )
  }
  return readFile(target, 'utf8')
}

/** Read at most `maxBytes` from the start; safe for hand-written huge files. */
export async function readPrefix(target, maxBytes) {
  let info
  try {
    info = await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', exists: false, truncated: false, size: 0 }
    throw error
  }
  if (!info.isFile()) throw new Error(`not a regular file: ${target}`)
  const limit = Math.min(Math.max(0, maxBytes), info.size)
  if (limit === 0) return { text: '', exists: true, truncated: false, size: info.size }
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      exists: true,
      truncated: info.size > limit,
      size: info.size,
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Commit `text` atomically. Retries the Windows rename lock window. */
export async function writeAtomic(target, text) {
  const directory = path.dirname(target)
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  let lastError
  try {
    await writeFile(temporary, text, 'utf8')
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rename(temporary, target)
        return
      } catch (error) {
        lastError = error
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
        await sleep(15 * (attempt + 1))
      }
    }
    throw lastError
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * Read-modify-write under the path lock.
 *
 * `mutate(doc)` may throw to reject the operation; nothing is written then.
 * It must return `{ doc, ...rest }`; the rest is forwarded to the caller.
 *
 * When `backupPath` is given and the content actually changes, the previous
 * file is written there first, so one backup always holds the state before
 * the most recent modification.
 */
export async function updateMemory(target, { maxBytes, mutate, backupPath, onOverflow }) {
  return withPathLock(target, async () => {
    const raw = await readFull(target, maxBytes, { hardMaxBytes: hardReadLimitFor(maxBytes) })
    const doc = parseMemory(raw ?? '')
    const outcome = mutate(doc)
    if (!outcome || !outcome.doc) {
      throw new Error('internal error: mutate() must return { doc }')
    }
    const text = renderMemory(outcome.doc)
    const bytes = Buffer.byteLength(text, 'utf8')
    // A write that shrinks the file is always allowed: otherwise a file that
    // already exceeds the cap could never be repaired with memory_forget.
    const previousBytes = raw === null ? 0 : Buffer.byteLength(raw, 'utf8')
    if (bytes > maxBytes && bytes >= previousBytes) {
      const extra = typeof onOverflow === 'function' ? onOverflow({ doc, bytes, maxBytes }) : ''
      const advice = extra
        ? ''
        : '; forget a topic (memory_forget), trim the file by hand, or raise maxFileBytes'
      throw new Error(
        `memory file would be ${bytes} bytes, above maxFileBytes (${maxBytes})${advice}` +
          (extra ? `\n\n${extra}` : ''),
      )
    }
    let backedUp = false
    if (backupPath && raw !== null && raw !== text) {
      await writeAtomic(backupPath, raw)
      backedUp = true
    }
    await writeAtomic(target, text)
    return { ...outcome, text, bytes, backedUp }
  })
}

/** Replace the memory file with the last backup. Returns the backup text. */
export async function restoreBackup(target, backupPath, { maxBytes, hardMaxBytes = maxBytes }) {
  return withPathLock(target, async () => {
    const previous = await readFull(backupPath, maxBytes, { hardMaxBytes })
    if (previous === null) {
      throw new Error('no backup yet; one is written before every modification')
    }
    await writeAtomic(target, previous)
    return previous
  })
}
