import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { upsertTopic } from '../lib/memory.js'
import { isInsideOrEqual, prepareTarget, targetFor } from '../lib/paths.js'
import { readFull, readPrefix, restoreBackup, updateMemory, withPathLock, writeAtomic, hardReadLimitFor } from '../lib/store.js'

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-wm-'))
}

test('the hard read limit never falls below 8 MiB and grows with the cap', () => {
  assert.equal(hardReadLimitFor(1024), 8 * 1024 * 1024)
  assert.equal(hardReadLimitFor(1048576), 8 * 1024 * 1024)
  assert.equal(hardReadLimitFor(32 * 1024 * 1024), 64 * 1024 * 1024)
})

test('readFull returns null for a missing file', async () => {
  const root = await workspace()
  try {
    assert.equal(await readFull(path.join(root, 'nope.md'), 1024), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateMemory creates a file through a temporary rename', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, '.dsh-memory', 'MEMORY.md')
    await mkdir(path.dirname(target), { recursive: true })
    const result = await updateMemory(target, {
      maxBytes: 65536,
      mutate: (doc) => upsertTopic(doc, { title: 'one', summary: 'first', details: 'body' }),
    })
    assert.equal(result.created, true)
    assert.equal(result.backedUp, false, 'no backup for the first write')
    const text = await readFile(target, 'utf8')
    assert.match(text, /## one/)
    assert.match(text, /\*\*Summary:\*\* first/)
    assert.deepEqual((await readdir(path.dirname(target))).filter((n) => n.endsWith('.tmp')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent updates on one path are serialized and lose nothing', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'MEMORY.md')
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        updateMemory(target, {
          maxBytes: 262144,
          mutate: (doc) => upsertTopic(doc, { title: `topic-${index}`, summary: `s${index}` }),
        }),
      ),
    )
    const text = await readFile(target, 'utf8')
    for (let index = 0; index < 20; index++) assert.match(text, new RegExp(`## topic-${index}\\b`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a throwing mutation leaves the file untouched', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'MEMORY.md')
    await writeFile(target, '## keep\n**Summary:** keep\n', 'utf8')
    await assert.rejects(
      updateMemory(target, {
        maxBytes: 65536,
        mutate: () => {
          throw new Error('nope')
        },
      }),
      /nope/,
    )
    assert.match(await readFile(target, 'utf8'), /## keep/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('oversized files are rejected before reading, unless a hard limit allows it', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'big.md')
    await writeFile(target, 'x'.repeat(2048), 'utf8')
    await assert.rejects(readFull(target, 1024), /hard read limit/)
    const allowed = await readFull(target, 1024, { hardMaxBytes: 4096 })
    assert.equal(allowed.length, 2048)
    await assert.rejects(readFull(target, 1024, { hardMaxBytes: 2047 }), /hard read limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an oversized file can be shrunk back under the cap', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'MEMORY.md')
    const big = `## keep\n**Summary:** s\n\n${'y'.repeat(3000)}\n`
    await writeFile(target, big, 'utf8')
    // The write is allowed because the result fits, even though the input did not.
    const result = await updateMemory(target, {
      maxBytes: 1024,
      mutate: (doc) => ({ doc: { preamble: '', topics: doc.topics.slice(0, 0) } }),
    })
    assert.ok(result.bytes <= 1024)
    assert.equal(await readFile(target, 'utf8'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readPrefix truncates instead of throwing', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'big.md')
    await writeFile(target, 'abcdef'.repeat(100), 'utf8')
    const result = await readPrefix(target, 30)
    assert.equal(result.exists, true)
    assert.equal(result.truncated, true)
    assert.equal(result.text.length, 30)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeAtomic leaves exactly one fresh file', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'MEMORY.md')
    await writeAtomic(target, 'old')
    await writeAtomic(target, 'new')
    assert.equal(await readFile(target, 'utf8'), 'new')
    assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('withPathLock surfaces the caller error and keeps the chain usable', async () => {
  const key = `lock-${Math.random()}`
  await assert.rejects(
    withPathLock(key, async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(await withPathLock(key, async () => 42), 42)
})

test('updateMemory writes one backup generation and skips identical content', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'MEMORY.md')
    const backup = `${target}.bak`
    const options = {
      maxBytes: 65536,
      backupPath: backup,
      mutate: (doc) => upsertTopic(doc, { title: 'a', summary: 's' }),
    }
    const first = await updateMemory(target, options)
    assert.equal(first.backedUp, false)
    assert.equal(await readFile(backup, 'utf8').catch(() => null), null)

    const second = await updateMemory(target, {
      maxBytes: 65536,
      backupPath: backup,
      mutate: (doc) => upsertTopic(doc, { title: 'b', summary: 's' }),
    })
    assert.equal(second.backedUp, true)
    assert.doesNotMatch(await readFile(backup, 'utf8'), /## b/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restoreBackup puts the backup back and reports a missing one', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'MEMORY.md')
    const backup = `${target}.bak`
    await assert.rejects(restoreBackup(target, backup, { maxBytes: 65536 }), /no backup yet/)
    await writeFile(target, 'current\n', 'utf8')
    await writeFile(backup, 'previous\n', 'utf8')
    const restored = await restoreBackup(target, backup, { maxBytes: 65536 })
    assert.equal(restored, 'previous\n')
    assert.equal(await readFile(target, 'utf8'), 'previous\n')
    assert.equal(await readFile(backup, 'utf8'), 'previous\n', 'the backup is not consumed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('targetFor refuses to escape the workspace root', () => {
  const root = path.resolve('C:/work/project')
  assert.throws(() => targetFor(root, '../escape.md'), /must stay inside/)
  assert.throws(() => targetFor(root, 'a/../../escape.md'), /must stay inside/)
  assert.equal(targetFor(root, '.dsh-memory/MEMORY.md'), path.join(root, '.dsh-memory', 'MEMORY.md'))
})

test('isInsideOrEqual treats equal and child paths as inside', () => {
  assert.equal(isInsideOrEqual('C:/work/project', 'C:/work/project'), true)
  assert.equal(isInsideOrEqual('C:/work/project', 'C:/work/project/src'), true)
  assert.equal(isInsideOrEqual('C:/work/project', 'C:/work/other'), false)
})

test('prepareTarget creates missing parents and reports a missing file', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, '.dsh-memory', 'MEMORY.md')
    assert.equal(await prepareTarget(root, target, { create: false }), null)
    const created = await prepareTarget(root, target, { create: true })
    assert.equal(created.target, target)
    assert.equal(await prepareTarget(root, target, { create: false }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a symlinked memory directory outside the workspace is rejected', async (t) => {
  const root = await workspace()
  const outside = await workspace()
  try {
    const link = path.join(root, '.dsh-memory')
    try {
      await symlink(outside, link, 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        t.skip(`symlinks unavailable: ${error.code}`)
        return
      }
      throw error
    }
    await writeFile(path.join(outside, 'MEMORY.md'), '## secret\n', 'utf8')
    await assert.rejects(
      prepareTarget(root, path.join(link, 'MEMORY.md'), { create: false }),
      /escapes the workspace root/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('a symlinked memory file is rejected', async (t) => {
  const root = await workspace()
  try {
    const real = path.join(root, 'real.md')
    const link = path.join(root, 'MEMORY.md')
    await writeFile(real, '## x\n', 'utf8')
    try {
      await symlink(real, link, 'file')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        t.skip(`file symlinks unavailable: ${error.code}`)
        return
      }
      throw error
    }
    await assert.rejects(prepareTarget(root, link, { create: false }), /symbolic link/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateMemory refuses to grow past maxBytes', async () => {
  const root = await workspace()
  try {
    const target = path.join(root, 'MEMORY.md')
    await assert.rejects(
      updateMemory(target, {
        maxBytes: 400,
        mutate: (doc) => upsertTopic(doc, { title: 'big', summary: 's', details: 'x'.repeat(1000) }),
      }),
      /maxFileBytes|would be/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
