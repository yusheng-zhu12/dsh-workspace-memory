import path from 'node:path'
import { realpathSync, lstatSync } from 'node:fs'
import { realpath, lstat, mkdir } from 'node:fs/promises'

/**
 * Resolve the session's effective directory without filesystem I/O.
 *
 * `workingDirectory` is the committed source of truth (it follows `cd`); the
 * session header is the fallback for older host compositions.
 */
export function sessionDirectory(agent, ctx) {
  const session = agent?.session ?? (agent?.id ? ctx?.get?.('sessions')?.get?.(agent.id) : undefined)
  if (!session) return undefined
  try {
    const workingDirectory = ctx?.get?.('workingDirectory')
    if (workingDirectory && typeof workingDirectory.get === 'function') {
      const directory = workingDirectory.get(session)
      if (typeof directory === 'string' && directory) return path.resolve(directory)
    }
  } catch {
    // Fall through to the header value.
  }
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd ? path.resolve(cwd) : undefined
}

/**
 * Anchor a session directory to a registered workspace root.
 *
 * A session started in `<workspace>/src` belongs to `<workspace>`; without a
 * matching registration the directory itself is the root. This keeps one
 * memory file per workspace instead of one per current subdirectory.
 */
export function workspaceRoot(directory, ctx) {
  const resolved = path.resolve(directory)
  let best = resolved
  let bestLength = -1
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    for (const workspace of registry?.list?.() ?? []) {
      if (typeof workspace?.path !== 'string' || !workspace.path) continue
      const candidate = path.resolve(workspace.path)
      if (isInsideOrEqual(candidate, resolved) && candidate.length > bestLength) {
        best = candidate
        bestLength = candidate.length
      }
    }
  } catch {
    // Registry unavailable: keep the session directory.
  }
  return best
}

export function isInsideOrEqual(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

export function isStrictlyInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/** Resolve the configured memory file and enforce that it stays in the root. */
export function targetFor(root, memoryFile) {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, memoryFile)
  if (!isStrictlyInside(resolvedRoot, target)) {
    throw new Error(`memoryFile must stay inside the workspace root: ${memoryFile}`)
  }
  return target
}

/**
 * Validate a target for a read or write.
 *
 * With `create`, missing directories are created. Returns null when the file
 * does not exist and `create` is false. Rejects symlinks and any path whose
 * real directory escapes the workspace root.
 */
export async function prepareTarget(root, target, { create = false } = {}) {
  const resolvedRoot = path.resolve(root)
  let realRoot
  try {
    realRoot = await realpath(resolvedRoot)
  } catch {
    throw new Error(`workspace directory is unavailable: ${resolvedRoot}`)
  }

  const directory = path.dirname(target)
  if (create) await mkdir(directory, { recursive: true })

  let realDirectory
  try {
    realDirectory = await realpath(directory)
  } catch (error) {
    if (!create && error?.code === 'ENOENT') return null
    throw error
  }
  if (!isInsideOrEqual(realRoot, realDirectory)) {
    throw new Error('memory path escapes the workspace root')
  }

  let info = null
  try {
    info = await lstat(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (info) {
    if (info.isSymbolicLink()) throw new Error('memory file is a symbolic link')
    if (!info.isFile()) throw new Error('memory path is not a regular file')
    const realTarget = await realpath(target)
    if (!isInsideOrEqual(realRoot, realTarget)) {
      throw new Error('memory file resolves outside the workspace root')
    }
  } else if (!create) {
    return null
  }

  return { target, directory }
}

/**
 * Synchronous safety check for the per-step digest path.
 *
 * Prompt context providers are synchronous, so this cannot await realpath.
 * It rejects symlinked files and directories that escape the root, which is
 * the property that matters for not leaking outside the workspace.
 */
export function verifySync(root, target) {
  try {
    const realRoot = realpathSync(root)
    const realDirectory = realpathSync(path.dirname(target))
    if (!isInsideOrEqual(realRoot, realDirectory)) return false
    const info = lstatSync(target)
    return info.isFile()
  } catch {
    return false
  }
}
