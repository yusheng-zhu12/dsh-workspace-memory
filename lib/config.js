import path from 'node:path'

/**
 * Resolved plugin configuration. Every value is validated once at activation so
 * a bad profile patch fails loudly instead of silently disabling the feature.
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  tools: true,
  inject: true,
  memoryFile: '.dsh-memory/MEMORY.md',
  injectBudget: 1200,
  maxTopics: 100,
  maxTopicBytes: 16384,
  maxFileBytes: 262144,
  maxReadChars: 32768,
  redact: true,
  backup: true,
  requireReadBeforeReplace: true,
})

const BOOLEAN_KEYS = ['enabled', 'tools', 'inject', 'redact', 'backup', 'requireReadBeforeReplace']

/**
 * [minimum, maximum] for every numeric option.
 *
 * The maxima are higher than the defaults on purpose: a workspace that outgrows
 * its memory can raise a limit after the user agrees, without a code change.
 */
const INTEGER_RANGES = {
  injectBudget: [200, 20000],
  maxTopics: [1, 10000],
  maxTopicBytes: [256, 4194304],
  maxFileBytes: [1024, 67108864],
  maxReadChars: [512, 8388608],
}

/** Upper bound of each storage limit, so callers never suggest a value above it. */
export const LIMIT_MAX = Object.freeze({
  maxTopics: INTEGER_RANGES.maxTopics[1],
  maxTopicBytes: INTEGER_RANGES.maxTopicBytes[1],
  maxFileBytes: INTEGER_RANGES.maxFileBytes[1],
})

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULT_CONFIG }

  for (const key of BOOLEAN_KEYS) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') {
      throw new Error(`dsh-workspace-memory: ${key} must be a boolean, got ${describe(input[key])}`)
    }
    config[key] = input[key]
  }

  // A disabled plugin must not be blocked by its own leftovers: otherwise a bad
  // memoryFile keeps the row failing and `enabled: false` cannot be used to get
  // the plugin out of the way.
  if (config.enabled === false) return config

  for (const [key, [min, max]] of Object.entries(INTEGER_RANGES)) {
    if (input[key] === undefined) continue
    const value = input[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`dsh-workspace-memory: ${key} must be an integer in [${min}, ${max}], got ${describe(value)}`)
    }
    config[key] = value
  }

  if (input.memoryFile !== undefined) {
    config.memoryFile = resolveMemoryFile(input.memoryFile)
  }

  if (config.maxFileBytes < config.maxTopicBytes) {
    throw new Error(
      `dsh-workspace-memory: maxFileBytes (${config.maxFileBytes}) must be at least maxTopicBytes (${config.maxTopicBytes})`,
    )
  }

  // Unknown keys are ignored on purpose: older configurations must keep
  // loading after an upgrade removes or renames an option.
  return config
}

export function resolveMemoryFile(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`dsh-workspace-memory: memoryFile must be a non-empty relative path, got ${describe(value)}`)
  }
  let file = value.trim()
  if (file.includes('\0')) throw new Error('dsh-workspace-memory: memoryFile must not contain NUL')

  // Reject drive-qualified spellings, including Windows drive-relative forms
  // such as `C:foo`, which `path.isAbsolute` does not treat as absolute.
  if (/^[A-Za-z]:/.test(file)) {
    throw new Error('dsh-workspace-memory: memoryFile must be relative to the workspace root')
  }
  if (path.isAbsolute(file)) {
    throw new Error('dsh-workspace-memory: memoryFile must be relative to the workspace root')
  }

  if (file.startsWith('./') || file.startsWith('.\\')) file = file.slice(2)
  if (!file) throw new Error('dsh-workspace-memory: memoryFile must name a file')

  const segments = file.split(/[\\/]/)
  for (const segment of segments) {
    if (!segment) throw new Error('dsh-workspace-memory: memoryFile must not contain empty path segments')
    if (segment === '.' || segment === '..') {
      throw new Error('dsh-workspace-memory: memoryFile must not contain "." or ".." segments')
    }
  }

  const normalized = path.normalize(file)
  const base = path.basename(normalized)
  if (!base || base === '.' || base === '..') {
    throw new Error('dsh-workspace-memory: memoryFile must name a file')
  }
  if (path.isAbsolute(normalized)) {
    throw new Error('dsh-workspace-memory: memoryFile must be relative to the workspace root')
  }
  return normalized
}
