import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bodyDigest,
  cleanTitle,
  findTopic,
  listTopics,
  lookupTitle,
  normalizeTitle,
  parseMemory,
  removeTopic,
  renderMemory,
  renderTopicBody,
  textLength,
  upsertTopic,
} from '../lib/memory.js'

const NOW = Date.parse('2026-11-11T06:20:00.000Z')

function sample() {
  return parseMemory(`# Workspace memory

Intro kept verbatim.

## auth: token refresh
<!-- dsh-memory: {"v":1,"updated":"2026-11-11T06:00:00.000Z","tags":["auth"]} -->
**Summary:** Access tokens live 15 minutes.

### Where it lives
- src/auth/refresh.ts
`)
}

test('empty input yields an empty document', () => {
  assert.deepEqual(parseMemory(''), { preamble: '', topics: [] })
  assert.equal(renderMemory({ preamble: '', topics: [] }), '')
})

test('parse keeps preamble, meta, summary and body', () => {
  const doc = sample()
  assert.equal(doc.preamble, '# Workspace memory\n\nIntro kept verbatim.')
  assert.equal(doc.topics.length, 1)
  const topic = doc.topics[0]
  assert.equal(topic.title, 'auth: token refresh')
  assert.equal(topic.summary, 'Access tokens live 15 minutes.')
  assert.deepEqual(topic.tags, ['auth'])
  assert.equal(topic.updated, Date.parse('2026-11-11T06:00:00.000Z'))
  assert.match(renderTopicBody(topic), /src\/auth\/refresh\.ts/)
  assert.match(renderTopicBody(topic), /\*\*Summary:\*\*/)
})

test('render(parse(x)) is stable', () => {
  const doc = sample()
  const rendered = renderMemory(doc)
  const again = parseMemory(rendered)
  assert.deepEqual(again, doc)
  assert.equal(renderMemory(again), rendered)
})

test('upsert creates, then replace updates in place', () => {
  const created = upsertTopic(sample(), {
    title: 'build: release',
    summary: 'pnpm build then pnpm test.',
    details: 'Run from the repository root.',
    tags: ['build'],
    now: NOW,
    session: 'abc12345',
  })
  assert.equal(created.created, true)
  assert.equal(created.replaced, false)
  assert.equal(created.doc.topics.length, 2)
  assert.equal(created.doc.topics[1].title, 'build: release')

  const replaced = upsertTopic(created.doc, {
    title: 'build: release',
    summary: 'Use the release script.',
    details: 'scripts/release.sh',
    now: NOW + 1000,
  })
  assert.equal(replaced.created, false)
  assert.equal(replaced.replaced, true)
  assert.equal(replaced.doc.topics.length, 2)
  assert.match(replaced.doc.topics[1].body, /scripts\/release\.sh/)
  assert.doesNotMatch(replaced.doc.topics[1].body, /pnpm build/)
  assert.match(replaced.doc.topics[1].body, /Use the release script\./)
})

test('upsert matches titles case-insensitively and keeps the stored spelling', () => {
  const doc = upsertTopic(sample(), {
    title: 'AUTH: Token Refresh',
    summary: 'updated',
    details: 'changed',
    now: NOW,
  })
  assert.equal(doc.doc.topics.length, 1)
  assert.equal(doc.doc.topics[0].title, 'auth: token refresh')
  assert.match(doc.doc.topics[0].body, /changed/)
})

test('append keeps existing details, replaces the summary and adds new details', () => {
  const result = upsertTopic(sample(), {
    title: 'auth: token refresh',
    summary: 'New summary.',
    details: 'New gotcha.',
    mode: 'append',
    now: NOW,
  })
  const body = renderTopicBody(result.topic)
  assert.match(body, /New summary\./)
  assert.match(body, /src\/auth\/refresh\.ts/)
  assert.match(body, /New gotcha\./)
  assert.equal((body.match(/\*\*Summary:\*\*/g) ?? []).length, 1)
})

test('preamble is preserved when adding a topic', () => {
  const result = upsertTopic(sample(), {
    title: 'parser: edge cases',
    summary: 'Empty input is valid.',
    now: NOW,
  })
  assert.equal(result.doc.preamble, sample().preamble)
  assert.match(renderMemory(result.doc), /Intro kept verbatim\./)
})

test('CRLF and BOM are normalized', () => {
  const doc = parseMemory('\uFEFF# title\r\n\r\n## one\r\n**Summary:** x\r\n')
  assert.equal(doc.preamble, '# title')
  assert.equal(doc.topics.length, 1)
  assert.equal(doc.topics[0].title, 'one')
})

test('malformed metadata stays as ordinary body text', () => {
  const doc = parseMemory('## topic\n<!-- dsh-memory: {oops} -->\n**Summary:** s\n')
  assert.equal(doc.topics[0].meta, null)
  assert.match(renderTopicBody(doc.topics[0]), /oops/)
})

test('a summary falls back to the first prose line', () => {
  const doc = parseMemory('## topic\nSome **plain** text.\n\nmore\n')
  assert.equal(doc.topics[0].summary, 'Some plain text.')
})

test('headings inside the body and blank lines before metadata are tolerated', () => {
  const doc = parseMemory(
    '## topic\n\n<!-- dsh-memory: {"updated":"2026-11-11T00:00:00Z"} -->\n**Summary:** s\n\n### sub\nbody\n',
  )
  assert.equal(doc.topics.length, 1)
  assert.equal(doc.topics[0].summary, 's')
  assert.match(renderTopicBody(doc.topics[0]), /### sub/)
})

test('duplicate titles parse as two topics; find and remove use the first', () => {
  const doc = parseMemory('## dup\n**Summary:** one\n\n## dup\n**Summary:** two\n')
  assert.equal(doc.topics.length, 2)
  assert.equal(findTopic(doc, 'DUP').summary, 'one')
  const removed = removeTopic(doc, 'dup')
  assert.equal(removed.removed.summary, 'one')
  assert.equal(removed.doc.topics.length, 1)
  assert.equal(removed.doc.topics[0].summary, 'two')
})

test('removeTopic reports a missing topic as null', () => {
  assert.equal(removeTopic(sample(), 'nope'), null)
})

test('renderTopicBody never returns the metadata comment', () => {
  assert.doesNotMatch(renderTopicBody(sample().topics[0]), /dsh-memory:/)
})

test('topic and summary validation rejects bad input', () => {
  assert.throws(() => normalizeTitle('   '), /must not be empty/)
  assert.throws(() => normalizeTitle('#'.repeat(10)), /must not be empty/)
  assert.throws(() => normalizeTitle('x'.repeat(121)), /at most 120/)
  assert.throws(() => upsertTopic(sample(), { title: 'ok', summary: '' }), /summary must not be empty/)
  assert.throws(() => upsertTopic(sample(), { title: 'ok', summary: 'x'.repeat(401) }), /at most 400/)
  assert.throws(
    () => upsertTopic(sample(), { title: 'ok', summary: 's', details: 'x'.repeat(20), maxBodyBytes: 10 }),
    /at most 10 bytes/,
  )
})

test('the topic cap only blocks new topics', () => {
  const doc = {
    preamble: '',
    topics: [{ title: 'a', body: '', meta: null, summary: '', updated: null, tags: [] }],
  }
  assert.throws(() => upsertTopic(doc, { title: 'b', summary: 's', maxTopics: 1 }), /already has 1 topics/)
  assert.doesNotThrow(() => upsertTopic(doc, { title: 'a', summary: 's', maxTopics: 1 }))
})

test('level-2 headings inside details are demoted, not split into topics', () => {
  const result = upsertTopic(sample(), {
    title: 'demo',
    summary: 's',
    details: '## Sub\nbody\n\n## Another\nmore',
    now: NOW,
  })
  assert.equal(result.doc.topics.length, 2)
  const rendered = renderMemory(result.doc)
  assert.match(rendered, /### Sub/)
  assert.match(rendered, /### Another/)
  assert.equal(parseMemory(rendered).topics.length, 2)
})

test('metadata containing "<!--" cannot break the comment', () => {
  const result = upsertTopic(sample(), {
    title: 'tricky',
    summary: 's',
    tags: ['a-->b'],
    now: NOW,
  })
  assert.match(renderMemory(result.doc), /a--\\u003eb/)
})

test('headings inside HTML comments are not topics', () => {
  const doc = parseMemory('# notes\n\n<!--\n## old heading kept for reference\n-->\n\n## real\n**Summary:** s\n')
  assert.equal(doc.topics.length, 1)
  assert.equal(doc.topics[0].title, 'real')
  assert.match(doc.preamble, /## old heading kept for reference/)
})

test('headings inside fenced code blocks are not topics', () => {
  const doc = parseMemory('## real\n**Summary:** s\n\n```md\n## example heading inside a fence\n```\n')
  assert.equal(doc.topics.length, 1)
  assert.match(doc.topics[0].body, /## example heading inside a fence/)
})

test('a fenced block with ~~~ is skipped too', () => {
  const doc = parseMemory('~~~\n## not a topic\n~~~\n\n## real\n**Summary:** s\n')
  assert.equal(doc.topics.length, 1)
  assert.equal(doc.topics[0].title, 'real')
})

test('a hand-edited file keeps its commented and fenced headings after a save', () => {
  const doc = parseMemory(
    '# notes\n\n<!--\n## old\n-->\n\n```md\n## example\n```\n\n## real\n**Summary:** s\n',
  )
  const result = upsertTopic(doc, { title: 'added', summary: 'new', now: NOW })
  const rendered = renderMemory(result.doc)
  assert.match(rendered, /<!--\n## old\n-->/)
  assert.match(rendered, /```md\n## example\n```/)
  assert.equal(parseMemory(rendered).topics.length, 2)
})

test('an inline comment inside a heading does not hide the topic', () => {
  const doc = parseMemory('## topic <!-- note -->\n**Summary:** s\nbody\n')
  assert.equal(doc.topics.length, 1)
  assert.equal(doc.topics[0].title, 'topic <!-- note -->')
  assert.equal(doc.topics[0].summary, 's')
})

test('an unterminated comment never hides the headings after it', () => {
  const doc = parseMemory('## a <!-- open\n**Summary:** s\n\n## b\n**Summary:** t\n')
  assert.deepEqual(
    doc.topics.map((topic) => topic.title),
    ['a <!-- open', 'b'],
  )

  const inBody = parseMemory('## a\n**Summary:** s\nbody <!-- open\n\n## b\n**Summary:** t\n')
  assert.deepEqual(
    inBody.topics.map((topic) => topic.title),
    ['a', 'b'],
  )
})

test('a closed comment block still hides the headings inside it', () => {
  const doc = parseMemory('# notes\n\n<!--\n## old\n-->\n\n## real\n**Summary:** s\n')
  assert.deepEqual(
    doc.topics.map((topic) => topic.title),
    ['real'],
  )
})

test('a saved note whose title contains a comment marker stays listable', () => {
  const result = upsertTopic(parseMemory(''), {
    title: 'demo <!-- note',
    summary: 's',
    details: 'body',
    now: NOW,
  })
  const reparsed = parseMemory(renderMemory(result.doc))
  assert.equal(reparsed.topics.length, 1)
  assert.equal(reparsed.topics[0].title, 'demo <!-- note')
})

test('lookupTitle accepts long hand-written headings that normalizeTitle rejects', () => {
  const long = 'a'.repeat(150)
  assert.throws(() => normalizeTitle(long), /at most 120/)
  assert.equal(lookupTitle(long), long)
  const longer = 'b'.repeat(600)
  assert.equal(lookupTitle(longer), longer, 'lookups must not truncate the title')
  assert.throws(() => lookupTitle('   '), /must not be empty/)
})

test('bodyDigest is stable per body and changes with the body', () => {
  const one = parseMemory('## a\n**Summary:** s\n\nbody\n').topics[0]
  const same = parseMemory('## a\n**Summary:** s\n\nbody\n').topics[0]
  const other = parseMemory('## a\n**Summary:** s\n\nother\n').topics[0]
  assert.equal(bodyDigest(one), bodyDigest(same))
  assert.notEqual(bodyDigest(one), bodyDigest(other))
})

test('textLength counts characters, not UTF-16 units', () => {
  assert.equal(textLength('abc'), 3)
  assert.equal(textLength('中文'), 2)
  assert.equal(textLength('🙂'), 1)
})

test('cleanTitle strips leading heading marks', () => {
  assert.equal(cleanTitle('  ##  hello   world  '), 'hello world')
})

test('listTopics carries summaries, timestamps and sizes', () => {
  const topics = listTopics(sample())
  assert.equal(topics.length, 1)
  assert.equal(topics[0].title, 'auth: token refresh')
  assert.equal(topics[0].summary, 'Access tokens live 15 minutes.')
  assert.ok(topics[0].bytes > 0)
})

test('upsert reports previous body size and whether the body was kept', () => {
  const first = upsertTopic(sample(), { title: 'x', summary: 's', details: 'abc', now: NOW })
  assert.equal(first.previous, null)
  assert.equal(first.keptBody, false)

  const appended = upsertTopic(first.doc, {
    title: 'x',
    summary: 's2',
    details: 'more',
    mode: 'append',
    now: NOW,
  })
  assert.equal(appended.keptBody, true)
  assert.ok(appended.previous.bodyBytes > 0)

  const replaced = upsertTopic(appended.doc, {
    title: 'x',
    summary: 's3',
    details: 'z',
    now: NOW,
  })
  assert.equal(replaced.keptBody, false)
  assert.ok(replaced.previous.bodyBytes > 0)
})
