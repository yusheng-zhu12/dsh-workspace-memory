import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-wm-wiring-'))
}

function createHost(root, { cwd = root } = {}) {
  const registered = new Map()
  const contexts = []
  const listeners = new Map()
  const disposers = []
  const agents = []

  const tools = {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }

  const systemPrompt = {
    context(options) {
      contexts.push(options)
      return () => {
        const index = contexts.indexOf(options)
        if (index >= 0) contexts.splice(index, 1)
      }
    },
  }

  const workingDirectory = { get: (value) => value?.header?.cwd ?? cwd }
  const workspaceRegistry = { list: () => [{ path: root }] }

  const makeScoped = () => ({
    systemPrompt,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get(name) {
      return name === 'systemPrompt' ? systemPrompt : undefined
    },
  })

  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'tools') return tools
      if (name === 'agents') return { list: () => agents }
      if (name === 'workingDirectory') return workingDirectory
      if (name === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(event, callback) {
      listeners.set(event, callback)
    },
    inject(_deps, callback) {
      callback({})
    },
  }

  function makeAgent(id, directory = cwd) {
    return { id, session: { header: { cwd: directory } }, ctx: makeScoped() }
  }

  return { ctx, registered, contexts, listeners, disposers, agents, makeAgent }
}

function tool(host, name) {
  const definition = host.registered.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition
}

test('apply registers six tools and a scoped prompt context per agent', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    assert.deepEqual([...host.registered.keys()].sort(), [
      'memory_forget',
      'memory_limits',
      'memory_list',
      'memory_read',
      'memory_restore',
      'memory_save',
    ])

    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    assert.equal(host.contexts.length, 1)
    assert.equal(host.contexts[0].name, 'dsh-workspace-memory')
    assert.equal(host.contexts[0].order, 62)
    assert.equal(host.contexts[0].text(), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('save, read, list and forget work through the tools', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')

    const saved = await tool(host, 'memory_save').execute(
      { topic: 'demo', summary: 'A demo note.', details: 'Details here.', tags: ['test'], mode: 'replace' },
      { agent },
    )
    assert.equal(saved.ok, true)
    assert.equal(saved.created, true)
    assert.equal(saved.topicCount, 1)
    assert.equal(saved.path, file)
    const fileText = await readFile(file, 'utf8')
    assert.match(fileText, /^# Workspace memory/)
    assert.match(fileText, /## demo/)
    assert.match(host.contexts[0].text(), /- demo — A demo note\./)

    const read = await tool(host, 'memory_read').execute({ topic: 'demo' }, { agent })
    assert.equal(read.ok, true)
    assert.match(read.text, /A demo note\./)
    assert.match(read.text, /Details here\./)

    const listed = await tool(host, 'memory_list').execute({}, { agent })
    assert.equal(listed.ok, true)
    assert.match(listed.text, /demo/)
    assert.equal(listed.topics.length, 1)

    const forgotten = await tool(host, 'memory_forget').execute({ topic: 'demo', confirm: true }, { agent })
    assert.equal(forgotten.ok, true)
    assert.equal(forgotten.topicCount, 0)
    assert.equal(host.contexts[0].text(), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('forget requires confirm, reports a missing topic, and uses singular grammar', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')
    await save.execute({ topic: 'one', summary: 's', mode: 'replace' }, { agent })
    await save.execute({ topic: 'two', summary: 's', mode: 'replace' }, { agent })

    const refused = await tool(host, 'memory_forget').execute({ topic: 'one' }, { agent })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /confirm must be true/)

    const missing = await tool(host, 'memory_forget').execute({ topic: 'nope', confirm: true }, { agent })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /no topic named/)

    const removed = await tool(host, 'memory_forget').execute({ topic: 'one', confirm: true }, { agent })
    assert.equal(removed.topicCount, 1)
    assert.match(removed.text, /1 topic remains\./)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mode is required by the schema and rejected when missing', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const schema = tool(host, 'memory_save').parameters
    assert.deepEqual(schema.required, ['topic', 'summary', 'mode'])
    assert.deepEqual(schema.properties.mode.enum, ['replace', 'append'])

    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const result = await tool(host, 'memory_save').execute({ topic: 'x', summary: 'y' }, { agent })
    assert.equal(result.ok, false)
    assert.match(result.error, /mode is required/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('replace that discards a substantial body warns; append does not', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')
    const read = tool(host, 'memory_read')

    await save.execute({ topic: 'big', summary: 'long note', details: 'x'.repeat(900), mode: 'replace' }, { agent })

    await read.execute({ topic: 'big' }, { agent })
    const shrunk = await save.execute(
      { topic: 'big', summary: 'short now', details: 'tiny', mode: 'replace' },
      { agent },
    )
    assert.equal(shrunk.ok, true)
    assert.ok(shrunk.discardedChars > 800, `discarded=${shrunk.discardedChars}`)
    assert.match(shrunk.text, /Warning: replace discarded/)
    assert.match(shrunk.text, /mode 'append'/)

    await read.execute({ topic: 'big' }, { agent })
    await save.execute({ topic: 'big', summary: 'long note', details: 'y'.repeat(900), mode: 'replace' }, { agent })
    const appended = await save.execute(
      { topic: 'big', summary: 'long note plus one', details: 'extra', mode: 'append' },
      { agent },
    )
    assert.equal(appended.ok, true)
    assert.equal(appended.discardedChars, 0)
    assert.doesNotMatch(appended.text, /Warning/)
    assert.match(appended.text, /appended; previous details kept/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a new topic reports neither append nor replace', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const created = await tool(host, 'memory_save').execute(
      { topic: 'fresh', summary: 's', mode: 'append' },
      { agent },
    )
    assert.equal(created.ok, true)
    assert.equal(created.created, true)
    assert.equal(created.discardedChars, 0)
    assert.doesNotMatch(created.text, /appended|replaced/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('replacing an unread topic is refused until it is read', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const first = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent: first })
    await tool(host, 'memory_save').execute(
      { topic: 'shared', summary: 'written earlier', details: 'original body', mode: 'replace' },
      { agent: first },
    )

    const second = host.makeAgent('agent-b')
    await host.listeners.get('agent/created')({ agent: second })
    const blocked = await tool(host, 'memory_save').execute(
      { topic: 'shared', summary: 'new', details: 'overwrite', mode: 'replace' },
      { agent: second },
    )
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /has not been read/)
    assert.match(blocked.error, /memory_read/)
    assert.match(await readFile(path.join(root, '.dsh-memory', 'MEMORY.md'), 'utf8'), /original body/)

    const appended = await tool(host, 'memory_save').execute(
      { topic: 'shared', summary: 'new', details: 'added line', mode: 'append' },
      { agent: second },
    )
    assert.equal(appended.ok, true)
    assert.match(appended.text, /appended; previous details kept/)

    await tool(host, 'memory_read').execute({ topic: 'shared' }, { agent: second })
    const allowed = await tool(host, 'memory_save').execute(
      { topic: 'shared', summary: 'new', details: 'overwrite', mode: 'replace' },
      { agent: second },
    )
    assert.equal(allowed.ok, true)
    assert.match(allowed.text, /replaced/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a read becomes stale after an external edit, so replace is refused again', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')

    await tool(host, 'memory_save').execute({ topic: 'doc', summary: 's', details: 'first', mode: 'replace' }, { agent })
    await tool(host, 'memory_read').execute({ topic: 'doc' }, { agent })

    await writeFile(file, `${await readFile(file, 'utf8')}\nHand edit.\n`, 'utf8')

    const blocked = await tool(host, 'memory_save').execute(
      { topic: 'doc', summary: 's2', details: 'second', mode: 'replace' },
      { agent },
    )
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /has not been read/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reading the whole file also marks its topics as read', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    await tool(host, 'memory_save').execute(
      { topic: 'whole', summary: 's', details: 'body', mode: 'replace' },
      { agent },
    )
    await tool(host, 'memory_read').execute({}, { agent })
    const allowed = await tool(host, 'memory_save').execute(
      { topic: 'whole', summary: 's2', details: 'body2', mode: 'replace' },
      { agent },
    )
    assert.equal(allowed.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a read in one conversation does not unlock a replace in another', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agentA = host.makeAgent('agent-a')
    const agentB = host.makeAgent('agent-b')
    await host.listeners.get('agent/created')({ agent: agentA })
    await host.listeners.get('agent/created')({ agent: agentB })

    await tool(host, 'memory_save').execute(
      { topic: 'shared', summary: 's1', details: 'original', mode: 'replace' },
      { agent: agentA },
    )
    await tool(host, 'memory_read').execute({ topic: 'shared' }, { agent: agentA })

    const blocked = await tool(host, 'memory_save').execute(
      { topic: 'shared', summary: 's2', details: 'B never read', mode: 'replace' },
      { agent: agentB },
    )
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /has not been read/)

    // The conversation that read it can still replace.
    const allowed = await tool(host, 'memory_save').execute(
      { topic: 'shared', summary: 's3', details: 'A read it', mode: 'replace' },
      { agent: agentA },
    )
    assert.equal(allowed.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writing one note does not invalidate the read mark of another', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')
    const read = tool(host, 'memory_read')

    await save.execute({ topic: 'alpha', summary: 'a1', details: 'one', mode: 'replace' }, { agent })
    await save.execute({ topic: 'beta', summary: 'b1', details: 'two', mode: 'replace' }, { agent })
    await read.execute({ topic: 'alpha' }, { agent })
    await read.execute({ topic: 'beta' }, { agent })

    const first = await save.execute(
      { topic: 'alpha', summary: 'a2', details: 'one changed', mode: 'replace' },
      { agent },
    )
    assert.equal(first.ok, true, 'first replace should succeed')

    const second = await save.execute(
      { topic: 'beta', summary: 'b2', details: 'two changed', mode: 'replace' },
      { agent },
    )
    assert.equal(second.ok, true, 'second replace must not be blocked by the first write')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a note can be replaced right after it was written', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')

    await save.execute({ topic: 'fresh', summary: 'one', details: 'a', mode: 'replace' }, { agent })
    const again = await save.execute({ topic: 'fresh', summary: 'two', details: 'b', mode: 'replace' }, { agent })
    assert.equal(again.ok, true)
    assert.match(again.text, /replaced/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a secret in the title is refused instead of stored', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')

    const result = await tool(host, 'memory_save').execute(
      { topic: 'api: sk-abcdefghijklmnopqrstuvwx', summary: 's', details: 'd', mode: 'replace' },
      { agent },
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /looks like a secret/)
    assert.match(result.error, /matched: sk-token/)
    // The surviving prefix must not be echoed back into the tool result.
    assert.doesNotMatch(result.error, /sk-abc/)
    assert.doesNotMatch(result.text, /sk-abc/)
    assert.equal(await readFile(file, 'utf8').catch(() => null), null, 'nothing is written')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hand-written 600-character heading can be read and deleted by name', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    const long = 'c'.repeat(600)
    await writeFile(file, `## ${long}\n**Summary:** long heading\n\nbody\n`, 'utf8')

    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const read = await tool(host, 'memory_read').execute({ topic: long }, { agent })
    assert.equal(read.ok, true)
    assert.match(read.text, /long heading/)

    const removed = await tool(host, 'memory_forget').execute({ topic: long, confirm: true }, { agent })
    assert.equal(removed.ok, true)
    assert.equal(removed.topicCount, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('secrets in tags are redacted before truncation', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    const token = `ghp_${'a'.repeat(36)}`

    const saved = await tool(host, 'memory_save').execute(
      { topic: 'tagged', summary: 's', details: 'd', tags: [token, 'ok'], mode: 'replace' },
      { agent },
    )
    assert.equal(saved.ok, true)
    assert.ok(saved.redactions >= 1, `redactions=${saved.redactions}`)
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, /a{20}/)
    assert.match(text, /\*\*\*\[redacted\]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a long hand-written title can still be read and deleted by name', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    const long = 'very long hand written heading '.repeat(6).trim()
    assert.ok(long.length > 120)
    await writeFile(file, `## ${long}\n**Summary:** hand written\n\nbody\n`, 'utf8')

    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const read = await tool(host, 'memory_read').execute({ topic: long }, { agent })
    assert.equal(read.ok, true)
    assert.match(read.text, /hand written/)

    const removed = await tool(host, 'memory_forget').execute({ topic: long, confirm: true }, { agent })
    assert.equal(removed.ok, true)
    assert.equal(removed.topicCount, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an oversized file can still be repaired with memory_forget', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `## keep\n**Summary:** s\n\n${'y'.repeat(2000)}\n\n## drop\n**Summary:** d\n\nsmall\n`,
      'utf8',
    )

    const host = createHost(root)
    apply(host.ctx, { maxFileBytes: 1024, maxTopicBytes: 1024 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const listed = await tool(host, 'memory_list').execute({}, { agent })
    assert.equal(listed.ok, true)
    assert.equal(listed.topics.length, 2)

    const removed = await tool(host, 'memory_forget').execute({ topic: 'drop', confirm: true }, { agent })
    assert.equal(removed.ok, true, 'forget must work on a file that is already over the cap')
    assert.doesNotMatch(await readFile(file, 'utf8'), /## drop/)

    // A write that grows the oversized file is still refused.
    const grow = await tool(host, 'memory_save').execute(
      { topic: 'another', summary: 's', details: 'z'.repeat(500), mode: 'replace' },
      { agent },
    )
    assert.equal(grow.ok, false)
    assert.match(grow.error, /maxFileBytes/)

    // Shrinking keeps working until the file is back under the cap.
    const final = await tool(host, 'memory_forget').execute({ topic: 'keep', confirm: true }, { agent })
    assert.equal(final.ok, true)
    assert.equal((await readFile(file, 'utf8')).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hitting the topic cap names the largest and oldest notes and asks the user', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, { maxTopics: 2 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')

    await save.execute({ topic: 'big one', summary: 's', details: 'x'.repeat(600), mode: 'replace' }, { agent })
    await save.execute({ topic: 'small one', summary: 's', details: 'tiny', mode: 'replace' }, { agent })
    const before = await readFile(file, 'utf8')

    const blocked = await save.execute({ topic: 'third', summary: 's', mode: 'replace' }, { agent })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /maxTopics limit/)
    assert.match(blocked.error, /Largest topics:|Topics \(largest first\):/)
    assert.match(blocked.error, /"big one"/)
    assert.match(blocked.error, /"small one"/)
    assert.match(blocked.error, /Ask the user which they want/)
    assert.match(blocked.error, /memory_limits/)
    assert.equal(await readFile(file, 'utf8'), before, 'nothing is written')

    // Updating an existing note is still allowed at the cap.
    const updated = await save.execute({ topic: 'big one', summary: 's2', details: 'shorter', mode: 'replace' }, { agent })
    assert.equal(updated.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hitting the file cap names candidate notes and asks the user', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, { maxFileBytes: 1024, maxTopicBytes: 1024 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')

    await save.execute({ topic: 'first note', summary: 's', details: 'x'.repeat(500), mode: 'replace' }, { agent })
    const blocked = await save.execute(
      { topic: 'second note', summary: 's', details: 'y'.repeat(700), mode: 'replace' },
      { agent },
    )
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /maxFileBytes/)
    assert.match(blocked.error, /"first note"/)
    assert.match(blocked.error, /Ask the user which they want/)
    assert.match(blocked.error, /memory_limits/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('memory_limits reports limits and usage without asking the user', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    await tool(host, 'memory_save').execute({ topic: 'one', summary: 's', details: 'body', mode: 'replace' }, { agent })

    const shown = await tool(host, 'memory_limits').execute({}, { agent })
    assert.equal(shown.ok, true)
    assert.match(shown.text, /100 topics/)
    assert.match(shown.text, /1 topic/)
    assert.match(shown.text, /% of the file cap/)
    assert.match(shown.text, /- "one"/)
    // Plenty of room left: showing the report must not tell the model to ask
    // the user about merging or raising anything.
    assert.doesNotMatch(shown.text, /Ask the user/)
    assert.doesNotMatch(shown.text, /close to its limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('memory_limits warns only when the memory is nearly full', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, { maxTopics: 2 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')
    await save.execute({ topic: 'a', summary: 's', mode: 'replace' }, { agent })
    await save.execute({ topic: 'b', summary: 's', mode: 'replace' }, { agent })

    const shown = await tool(host, 'memory_limits').execute({}, { agent })
    assert.equal(shown.ok, true)
    assert.match(shown.text, /close to its limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a change that cannot be persisted is refused before the user is asked', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    let asked = 0
    host.ctx.get = ((original) => (name) => {
      if (name === 'userQuestions') {
        return {
          async ask() {
            asked++
            return { answers: [{ id: 'memory-limits', selected: ['Raise'] }] }
          },
        }
      }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const nothing = await tool(host, 'memory_limits').execute({ action: 'raise' }, { agent })
    assert.equal(nothing.ok, false)
    assert.match(nothing.error, /name at least one/)

    // An answerer exists but no config editor: refuse without burning the
    // user's confirmation.
    const noEditor = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 500 }, { agent })
    assert.equal(noEditor.ok, false)
    assert.match(noEditor.error, /cannot persist configuration/)
    assert.equal(asked, 0, 'the user must not be prompted for a change that cannot be written')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('without a question service the change fails closed', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    host.ctx.fiber = { entry: { id: 'workspace-memory' } }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') return { async edit() {} }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const noAsker = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 500 }, { agent })
    assert.equal(noAsker.ok, false)
    assert.match(noAsker.error, /cannot be asked from this context/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cancelled question counts as a decline, not as a missing service', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    const calls = []
    host.ctx.fiber = { entry: { id: 'workspace-memory' } }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') return { async edit(t, c) { calls.push(c({})) } }
      if (name === 'userQuestions') {
        return {
          async ask() {
            const error = new Error('the user cancelled')
            error.code = 'ASK_CANCELLED'
            throw error
          },
        }
      }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const result = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 500 }, { agent })
    assert.equal(result.ok, true)
    assert.match(result.text, /cancelled/)
    assert.doesNotMatch(result.text, /cannot be asked/)
    assert.equal(calls.length, 0, 'a cancelled question writes nothing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed question reports the real reason and writes nothing', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    const calls = []
    host.ctx.fiber = { entry: { id: 'workspace-memory' } }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') return { async edit(t, c) { calls.push(c({})) } }
      if (name === 'userQuestions') {
        return {
          async ask() {
            throw new Error('answerer exploded')
          },
        }
      }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const result = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 500 }, { agent })
    assert.equal(result.ok, false)
    assert.match(result.error, /asking the user failed/)
    assert.match(result.error, /answerer exploded/)
    assert.equal(calls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raise is held to the stored usage, not just the configured cap', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    // Six notes and a 2.8 KB file, while the configured caps are much smaller.
    const notes = Array.from(
      { length: 6 },
      (_, index) => `## note-${index}\n**Summary:** s\n\n${'y'.repeat(400)}`,
    ).join('\n\n')
    await writeFile(file, `${notes}\n`, 'utf8')

    const host = createHost(root)
    host.ctx.fiber = { entry: { id: 'workspace-memory' } }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') return { async edit() {} }
      if (name === 'userQuestions') {
        return {
          async ask(request) {
            // Approve with whichever verb the tool asked for (`Raise` / `Apply`).
            return { answers: [{ id: 'memory-limits', selected: [request.questions[0].options[0].label] }] }
          },
        }
      }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, { maxTopics: 2, maxFileBytes: 1024, maxTopicBytes: 1024 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const topics = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 4 }, { agent })
    assert.equal(topics.ok, false)
    assert.match(topics.error, /cannot be raised to 4/)
    assert.match(topics.error, /6 topics already stored/)
    assert.match(topics.error, /above 6/)
    assert.match(topics.error, /for example 7/)

    const bytes = await tool(host, 'memory_limits').execute({ action: 'raise', maxFileBytes: 2048 }, { agent })
    assert.equal(bytes.ok, false)
    assert.match(bytes.error, /cannot be raised to 2048/)
    assert.match(bytes.error, /bytes already stored/)

    // Exactly the stored usage leaves no room, so `raise` refuses it too.
    const exact = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 6 }, { agent })
    assert.equal(exact.ok, false)
    assert.match(exact.error, /cannot be raised to 6/)

    // One above the stored usage is the smallest raise that helps.
    const room = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 7 }, { agent })
    assert.equal(room.ok, true)
    assert.match(room.text, /Raised/)

    // `set` may freeze the usage exactly: nothing new fits, but nothing breaks.
    const frozen = await tool(host, 'memory_limits').execute({ action: 'set', maxTopics: 6 }, { agent })
    assert.equal(frozen.ok, true)
    assert.match(frozen.text, /Set/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('show counts every topic even when the file is over its cap', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    const notes = Array.from(
      { length: 6 },
      (_, index) => `## note-${index}\n**Summary:** s\n\n${'y'.repeat(400)}`,
    ).join('\n\n')
    await writeFile(file, `${notes}\n`, 'utf8')

    const host = createHost(root)
    apply(host.ctx, { maxFileBytes: 1024, maxTopicBytes: 1024 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const shown = await tool(host, 'memory_limits').execute({}, { agent })
    assert.equal(shown.ok, true)
    assert.match(shown.text, /6 topics/)
    assert.match(shown.text, /"note-5"/)
    assert.doesNotMatch(shown.text, /at least/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('at the hard ceiling the refusal names the maximum instead of suggesting an impossible value', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    // The ceiling for maxTopics is 10000; fill the file to it.
    const notes = Array.from({ length: 10000 }, (_, index) => `## n${index}\n**Summary:** s`).join('\n\n')
    await writeFile(file, `${notes}\n`, 'utf8')

    const host = createHost(root)
    host.ctx.fiber = { entry: { id: 'workspace-memory' } }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') return { async edit() {} }
      if (name === 'userQuestions') return { async ask() { return { answers: [] } } }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, { maxTopics: 2, maxTopicBytes: 4194304, maxFileBytes: 67108864 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const result = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 10000 }, { agent })
    assert.equal(result.ok, false)
    assert.match(result.error, /10000 is the maximum/)
    assert.doesNotMatch(result.error, /10001/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a file past the read limit cannot be measured, so a limit change is refused', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    // hardReadLimitFor(1024) is 8 MiB; write just past it.
    const block = `## big\n**Summary:** s\n\n${'z'.repeat(1024 * 1024)}\n\n`
    await writeFile(file, block.repeat(9), 'utf8')

    const host = createHost(root)
    host.ctx.fiber = { entry: { id: 'workspace-memory' } }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') return { async edit() {} }
      if (name === 'userQuestions') return { async ask() { return { answers: [] } } }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, { maxFileBytes: 1024, maxTopicBytes: 1024 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const result = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 200 }, { agent })
    assert.equal(result.ok, false)
    assert.match(result.error, /larger than the read limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a no-op raise at the stored usage says it leaves no room', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, { maxTopics: 2 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')
    await save.execute({ topic: 'a', summary: 's', mode: 'replace' }, { agent })
    await save.execute({ topic: 'b', summary: 's', mode: 'replace' }, { agent })

    const result = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 2 }, { agent })
    assert.equal(result.ok, true)
    assert.match(result.text, /nothing changed/)
    assert.match(result.text, /leaves no room/)
    assert.match(result.text, /raise above the stored usage/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raising to the value it already has changes nothing', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    let asked = 0
    host.ctx.fiber = { entry: { id: 'workspace-memory' } }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') return { async edit() {} }
      if (name === 'userQuestions') {
        return {
          async ask() {
            asked++
            return { answers: [{ id: 'memory-limits', selected: ['Raise'] }] }
          },
        }
      }
      return original(name)
    })(host.ctx.get)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const result = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 100 }, { agent })
    assert.equal(result.ok, true)
    assert.match(result.text, /already 100 topics/)
    assert.match(result.text, /nothing changed/)
    assert.equal(asked, 0, 'a no-op must not prompt the user')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raising a limit cannot lower it', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const lowered = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 1 }, { agent })
    assert.equal(lowered.ok, false)
    assert.match(lowered.error, /can only be raised/)
    assert.match(lowered.error, /action 'set'/)

    const loweredBytes = await tool(host, 'memory_limits').execute(
      { action: 'raise', maxFileBytes: 1024 },
      { agent },
    )
    assert.equal(loweredBytes.ok, false)
    assert.match(loweredBytes.error, /can only be raised/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('set lowers a limit after the user agrees, but never below what is stored', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    const calls = []
    const entry = { id: 'workspace-memory' }
    let answer = { answers: [{ id: 'memory-limits', selected: ['Apply'] }] }
    host.ctx.fiber = { entry }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') {
        return {
          async edit(target, change) {
            calls.push({ target, next: change({}) })
          },
        }
      }
      if (name === 'userQuestions') {
        return { async ask() { return answer } }
      }
      return original(name)
    })(host.ctx.get)

    apply(host.ctx, { maxTopics: 10 })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const save = tool(host, 'memory_save')
    await save.execute({ topic: 'one', summary: 's', details: 'body', mode: 'replace' }, { agent })
    await save.execute({ topic: 'two', summary: 's', details: 'body', mode: 'replace' }, { agent })

    // Lowering to a value still above the stored usage is allowed.
    const lowered = await tool(host, 'memory_limits').execute({ action: 'set', maxTopics: 5 }, { agent })
    assert.equal(lowered.ok, true)
    assert.match(lowered.text, /Set the workspace memory limits/)
    assert.match(lowered.text, /5 topics/)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].next, { maxTopics: 5 })

    // A cap below the stored usage would lock existing notes.
    const locked = await tool(host, 'memory_limits').execute({ action: 'set', maxTopics: 1 }, { agent })
    assert.equal(locked.ok, false)
    assert.match(locked.error, /cannot be set to 1/)
    assert.match(locked.error, /2 topics already stored/)
    assert.equal(calls.length, 1, 'a refused set is not persisted')

    // The same guard applies to the per-note cap: a note already written may
    // not be made bigger than the new limit.
    await save.execute({ topic: 'big', summary: 's', details: 'x'.repeat(600), mode: 'replace' }, { agent })
    const lockedNote = await tool(host, 'memory_limits').execute(
      { action: 'set', maxTopicBytes: 256 },
      { agent },
    )
    assert.equal(lockedNote.ok, false)
    assert.match(lockedNote.error, /bytes in the largest note/)

    // Declining leaves everything alone.
    answer = { answers: [{ id: 'memory-limits', selected: ['Cancel'] }] }
    const declined = await tool(host, 'memory_limits').execute({ action: 'set', maxTopics: 8 }, { agent })
    assert.equal(declined.ok, true)
    assert.match(declined.text, /declined/)
    assert.equal(calls.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raising a limit persists only after the user answers yes', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    const calls = []
    const asked = []
    const entry = { id: 'workspace-memory' }
    let answer = { answers: [{ id: 'memory-limits', selected: ['Raise'] }] }
    host.ctx.fiber = { entry }
    host.ctx.get = ((original) => (name) => {
      if (name === 'configEditor') {
        return {
          async edit(target, change) {
            calls.push({ target, next: change({}) })
          },
        }
      }
      if (name === 'userQuestions') {
        return {
          async ask(request) {
            asked.push(request)
            return answer
          },
        }
      }
      return original(name)
    })(host.ctx.get)

    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    const raised = await tool(host, 'memory_limits').execute(
      { action: 'raise', maxTopics: 500, maxFileBytes: 2 * 1024 * 1024 },
      { agent },
    )
    assert.equal(raised.ok, true)
    assert.match(raised.text, /500 topics/)
    assert.equal(asked.length, 1)
    assert.equal(asked[0].questions[0].id, 'memory-limits')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].next, { maxTopics: 500, maxFileBytes: 2 * 1024 * 1024 })

    // A declined answer changes nothing.
    answer = { answers: [{ id: 'memory-limits', selected: ['Cancel'] }] }
    const declined = await tool(host, 'memory_limits').execute({ action: 'raise', maxTopics: 900 }, { agent })
    assert.equal(declined.ok, true)
    assert.match(declined.text, /declined/)
    assert.equal(calls.length, 1, 'a declined request is not persisted')

    // Out-of-range values are rejected before anything is asked.
    const invalid = await tool(host, 'memory_limits').execute(
      { action: 'raise', maxFileBytes: 128 * 1024 * 1024 },
      { agent },
    )
    assert.equal(invalid.ok, false)
    assert.match(invalid.error, /maxFileBytes/)
    assert.equal(calls.length, 1, 'an invalid value is not persisted')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tools register even when the service mounts after apply', async () => {
  const root = await workspace()
  try {
    const registered = new Map()
    const deferred = []
    let toolsService
    let promptService

    const agent = {
      id: 'late-agent',
      session: { header: { cwd: root } },
      ctx: {
        get: (name) => (name === 'systemPrompt' ? promptService : undefined),
        effect: (fn) => fn(),
        systemPrompt: undefined,
      },
    }
    const scoped = {
      get: (name) => (name === 'systemPrompt' ? promptService : undefined),
      effect: (fn) => fn(),
      systemPrompt: undefined,
    }
    const agents = [agent]

    const ctx = {
      logger: { info() {}, warn() {} },
      get(name) {
        if (name === 'tools') return toolsService
        if (name === 'agents') return { list: () => agents }
        if (name === 'workingDirectory') return { get: (session) => session.header.cwd }
        if (name === 'workspaceRegistry') return { list: () => [{ path: root }] }
        if (name === 'systemPrompt') return promptService
        return undefined
      },
      effect: (fn) => fn(),
      on() {},
      inject(_deps, callback) {
        deferred.push(callback)
      },
    }

    apply(ctx, {})
    assert.equal(registered.size, 0, 'nothing registers before the services exist')

    // The host mounts the services later and runs the deferred callbacks.
    toolsService = {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    }
    promptService = {
      context() {
        return () => {}
      },
    }
    agent.ctx.systemPrompt = promptService
    for (const callback of deferred) callback({ tools: toolsService, systemPrompt: promptService })

    assert.deepEqual([...registered.keys()].sort(), [
      'memory_forget',
      'memory_limits',
      'memory_list',
      'memory_read',
      'memory_restore',
      'memory_save',
    ])

    const saved = await tool({ registered }, 'memory_save').execute(
      { topic: 'late', summary: 's', mode: 'replace' },
      { agent },
    )
    assert.equal(saved.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a backup of the previous file is kept, and only the last one', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    const backup = `${file}.bak`
    const save = tool(host, 'memory_save')

    await save.execute({ topic: 'one', summary: 'v1', details: 'body v1', mode: 'replace' }, { agent })
    assert.equal(await readFile(backup, 'utf8').catch(() => null), null, 'no backup before the first write')

    await save.execute({ topic: 'two', summary: 'v2', details: 'body v2', mode: 'replace' }, { agent })
    const firstBackup = await readFile(backup, 'utf8')
    assert.match(firstBackup, /## one/)
    assert.doesNotMatch(firstBackup, /## two/)

    await save.execute({ topic: 'three', summary: 'v3', details: 'body v3', mode: 'replace' }, { agent })
    const secondBackup = await readFile(backup, 'utf8')
    assert.match(secondBackup, /## two/)
    assert.doesNotMatch(secondBackup, /## three/)
    assert.deepEqual(
      (await readdir(path.dirname(file))).filter((name) => name.endsWith('.bak')),
      ['MEMORY.md.bak'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('memory_restore brings the previous file back and keeps the backup', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')

    await tool(host, 'memory_save').execute(
      { topic: 'keep', summary: 'good', details: 'important content', mode: 'replace' },
      { agent },
    )
    await tool(host, 'memory_save').execute(
      { topic: 'oops', summary: 'bad', details: 'clobbered', mode: 'replace' },
      { agent },
    )
    await tool(host, 'memory_forget').execute({ topic: 'keep', confirm: true }, { agent })
    assert.doesNotMatch(await readFile(file, 'utf8'), /important content/)

    const refused = await tool(host, 'memory_restore').execute({}, { agent })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /confirm must be true/)

    const restored = await tool(host, 'memory_restore').execute({ confirm: true }, { agent })
    assert.equal(restored.ok, true)
    const text = await readFile(file, 'utf8')
    assert.match(text, /## keep/)
    assert.match(text, /important content/)
    assert.ok(await readFile(`${file}.bak`, 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('memory_restore reports a missing backup', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const result = await tool(host, 'memory_restore').execute({ confirm: true }, { agent })
    assert.equal(result.ok, false)
    assert.match(result.error, /no backup yet/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('backup and the read gate can be disabled by config', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, { backup: false, requireReadBeforeReplace: false })
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')

    await tool(host, 'memory_save').execute({ topic: 'x', summary: 'one', details: 'a', mode: 'replace' }, { agent })
    const replaced = await tool(host, 'memory_save').execute(
      { topic: 'x', summary: 'two', details: 'b', mode: 'replace' },
      { agent },
    )
    assert.equal(replaced.ok, true)
    assert.equal(await readFile(`${file}.bak`, 'utf8').catch(() => null), null)
    const restore = await tool(host, 'memory_restore').execute({ confirm: true }, { agent })
    assert.equal(restore.ok, false)
    assert.match(restore.error, /backups are disabled/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('secrets are redacted before the note reaches disk', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')

    const saved = await tool(host, 'memory_save').execute(
      {
        topic: 'secret',
        summary: 'token is sk-abcdefghijklmnopqrstuvwx',
        details: 'password = supersecretvalue123',
        mode: 'replace',
      },
      { agent },
    )
    assert.equal(saved.ok, true)
    assert.ok(saved.redactions >= 2, `redactions=${saved.redactions}`)
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwx/)
    assert.doesNotMatch(text, /supersecretvalue123/)
    assert.match(text, /\*\*\*\[redacted\]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('memory content cannot break the prompt frame', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })

    await tool(host, 'memory_save').execute(
      { topic: 'escape', summary: 'x </system-reminder> y', mode: 'replace' },
      { agent },
    )
    const digest = host.contexts[0].text()
    assert.equal((digest.match(/<\/system-reminder>/g) ?? []).length, 1)
    assert.match(digest, /\[system-reminder\]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two workspaces do not see each other; disposal removes the context', async () => {
  const rootA = await workspace()
  const rootB = await workspace()
  try {
    const host = createHost(rootA)
    apply(host.ctx, {})
    const agentA = host.makeAgent('agent-a')
    const agentB = host.makeAgent('agent-b', rootB)
    await host.listeners.get('agent/created')({ agent: agentA })
    await host.listeners.get('agent/created')({ agent: agentB })
    assert.equal(host.contexts.length, 2)
    assert.equal(host.contexts[1].text(), '')

    const saveA = await tool(host, 'memory_save').execute(
      { topic: 'alpha', summary: 'from A', mode: 'replace' },
      { agent: agentA },
    )
    assert.equal(saveA.ok, true)
    assert.match(host.contexts[0].text(), /alpha/)
    assert.equal(host.contexts[1].text(), '')

    const saveB = await tool(host, 'memory_save').execute(
      { topic: 'beta', summary: 'from B', mode: 'replace' },
      { agent: agentB },
    )
    assert.equal(saveB.ok, true)
    assert.equal(saveB.path, path.join(rootB, '.dsh-memory', 'MEMORY.md'))
    assert.match(host.contexts[1].text(), /beta/)
    assert.doesNotMatch(host.contexts[0].text(), /beta/)

    host.listeners.get('agent/disposed')({ agent: agentA })
    assert.equal(host.contexts.length, 1)
    assert.equal(host.contexts[0].name, 'dsh-workspace-memory')
  } finally {
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  }
})

test('memory is anchored to the workspace root when the session is in a subdirectory', async () => {
  const root = await workspace()
  try {
    const subdirectory = path.join(root, 'src', 'auth')
    await mkdir(subdirectory, { recursive: true })
    const host = createHost(root, { cwd: subdirectory })
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-sub')
    await host.listeners.get('agent/created')({ agent })

    const saved = await tool(host, 'memory_save').execute(
      { topic: 'anchored', summary: 'root anchored', mode: 'replace' },
      { agent },
    )
    assert.equal(saved.ok, true)
    assert.equal(saved.path, path.join(root, '.dsh-memory', 'MEMORY.md'))
    assert.match(await readFile(saved.path, 'utf8'), /anchored/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hand-edited preamble is preserved instead of replaced by the default header', async () => {
  const root = await workspace()
  try {
    const file = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '# Custom intro\n\nKeep me.\n', 'utf8')

    const host = createHost(root)
    apply(host.ctx, {})
    const agent = host.makeAgent('agent-a')
    await host.listeners.get('agent/created')({ agent })
    const saved = await tool(host, 'memory_save').execute({ topic: 'added', summary: 'new note', mode: 'replace' }, { agent })
    assert.equal(saved.ok, true)
    const text = await readFile(file, 'utf8')
    assert.match(text, /# Custom intro/)
    assert.match(text, /Keep me\./)
    assert.doesNotMatch(text, /# Workspace memory/)
    assert.match(text, /## added/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a tool call without a live agent fails cleanly', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, {})
    const result = await tool(host, 'memory_save').execute({ topic: 'x', summary: 'y', mode: 'replace' }, {})
    assert.equal(result.ok, false)
    assert.match(result.error, /live conversation workspace/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid config fails activation instead of silently disabling', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    assert.throws(() => apply(host.ctx, { enabled: 'yes' }), /enabled must be a boolean/)
    assert.equal(host.registered.size, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('disabled config registers nothing', async () => {
  const root = await workspace()
  try {
    const host = createHost(root)
    apply(host.ctx, { enabled: false })
    assert.equal(host.registered.size, 0)
    assert.equal(host.listeners.size, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
