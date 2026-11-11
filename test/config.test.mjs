import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DEFAULT_CONFIG, resolveConfig, resolveMemoryFile } from '../lib/config.js'

test('defaults are complete and frozen', () => {
  assert.equal(DEFAULT_CONFIG.memoryFile, '.dsh-memory/MEMORY.md')
  assert.equal(DEFAULT_CONFIG.requireReadBeforeReplace, true)
  assert.equal(DEFAULT_CONFIG.backup, true)
  assert.equal(resolveConfig(undefined).memoryFile, DEFAULT_CONFIG.memoryFile)
  assert.equal(resolveConfig(null).enabled, true)
})

test('memoryFile accepts ordinary relative paths', () => {
  assert.equal(resolveMemoryFile('.dsh-memory/MEMORY.md'), path.join('.dsh-memory', 'MEMORY.md'))
  assert.equal(resolveMemoryFile('./MEMORY.md'), 'MEMORY.md')
  assert.equal(resolveMemoryFile('notes/memory.md'), path.join('notes', 'memory.md'))
})

test('memoryFile rejects paths that do not name a file inside the root', () => {
  for (const value of ['.', '..', './', 'a/.', 'a/..', 'a//b', '../x.md', '/abs.md', 'C:foo', 'C:\\abs.md', '', '   ']) {
    assert.throws(() => resolveMemoryFile(value), /memoryFile/, `expected ${JSON.stringify(value)} to be rejected`)
  }
  assert.throws(() => resolveMemoryFile('a\0b.md'), /NUL/)
  assert.throws(() => resolveMemoryFile(42), /non-empty relative path/)
})

test('bad memoryFile fails activation instead of failing every call later', () => {
  assert.throws(() => resolveConfig({ memoryFile: '.' }), /memoryFile/)
  assert.throws(() => resolveConfig({ memoryFile: 'C:foo' }), /memoryFile/)
  assert.throws(() => resolveConfig({ memoryFile: 'a/.' }), /memoryFile/)
})

test('a disabled plugin ignores the rest of its configuration', () => {
  const config = resolveConfig({ enabled: false, memoryFile: '.', injectBudget: -1 })
  assert.equal(config.enabled, false)
  assert.equal(config.memoryFile, DEFAULT_CONFIG.memoryFile)
})

test('booleans and integers are validated', () => {
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ inject: 1 }), /inject must be a boolean/)
  assert.throws(() => resolveConfig({ injectBudget: 100 }), /injectBudget must be an integer/)
  assert.throws(() => resolveConfig({ maxTopics: 1.5 }), /maxTopics must be an integer/)
  assert.throws(() => resolveConfig({ maxFileBytes: 1024, maxTopicBytes: 4096 }), /must be at least/)
})

test('defaults stay conservative, and the ceilings allow raising them later', () => {
  assert.equal(DEFAULT_CONFIG.maxTopics, 100)
  assert.equal(DEFAULT_CONFIG.maxTopicBytes, 16384)
  assert.equal(DEFAULT_CONFIG.maxFileBytes, 262144)
  assert.equal(DEFAULT_CONFIG.maxReadChars, 32768)

  const big = resolveConfig({
    maxTopics: 5000,
    maxFileBytes: 32 * 1024 * 1024,
    maxTopicBytes: 1024 * 1024,
    maxReadChars: 4 * 1024 * 1024,
  })
  assert.equal(big.maxTopics, 5000)
  assert.equal(big.maxFileBytes, 32 * 1024 * 1024)

  assert.throws(() => resolveConfig({ maxFileBytes: 128 * 1024 * 1024 }), /maxFileBytes/)
  assert.throws(() => resolveConfig({ maxTopics: 20000 }), /maxTopics/)
})

test('unknown keys are ignored so old configurations keep loading', () => {
  const config = resolveConfig({ somethingRemoved: true, memoryFile: 'm.md' })
  assert.equal(config.memoryFile, 'm.md')
  assert.equal('somethingRemoved' in config, false)
})
