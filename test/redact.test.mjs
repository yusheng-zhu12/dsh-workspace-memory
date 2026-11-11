import test from 'node:test'
import assert from 'node:assert/strict'
import { REDACT_MARK, RULE_NAMES, redact, totalHits } from '../lib/redact.js'

function expectRedacted(input, marker) {
  const result = redact(input)
  assert.ok(result.hits.length > 0, `expected a hit for ${input}`)
  assert.match(result.text, marker ?? /\*\*\*\[redacted\]/)
  return result
}

test('OpenAI-style keys keep a short prefix', () => {
  const result = expectRedacted('key sk-abcdefghijklmnopqrstuvwx here')
  assert.match(result.text, /sk-abc\*\*\*\[redacted\]/)
  assert.doesNotMatch(result.text, /abcdefghijklmnopqrstuvwx/)
})

test('GitHub tokens', () => {
  const token = `ghp_${'a'.repeat(36)}`
  const result = expectRedacted(`token=${token}`)
  assert.doesNotMatch(result.text, /a{20}/)
})

test('AWS and Aliyun access keys', () => {
  expectRedacted('AKIAABCDEFGHIJKLMNOP')
  expectRedacted('LTAIabcdefghijkl')
})

test('JWTs', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const result = expectRedacted(`Authorization: ${jwt}`)
  assert.doesNotMatch(result.text, /SflKxwRJSMeKKF2QT4/)
})

test('Bearer headers', () => {
  expectRedacted(`Bearer ${'A'.repeat(24)}`)
})

test('key/value secrets keep the key name', () => {
  const result = expectRedacted('password = "supersecretvalue123"')
  assert.match(result.text, /password=\*\*\*\[redacted\]/)
  assert.doesNotMatch(result.text, /supersecretvalue123/)
})

test('PEM private key blocks are removed whole', () => {
  const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'].join('\n')
  const result = redact(`before\n${pem}\nafter`)
  assert.ok(result.hits.some((hit) => hit.name === 'pem-private-key'))
  assert.equal(result.text, `before\n${REDACT_MARK}\nafter`)
})

test('ordinary prose is left alone', () => {
  const text = 'The parser accepts an empty file and returns no topics. Use memory_list to inspect.'
  const result = redact(text)
  assert.equal(result.text, text)
  assert.deepEqual(result.hits, [])
})

test('redaction is idempotent', () => {
  const once = redact('sk-abcdefghijklmnopqrstuvwx and password=abcdefghijklmnop').text
  assert.equal(redact(once).text, once)
})

test('totalHits sums rule counters', () => {
  const result = redact('sk-abcdefghijklmnopqrstuvwx AKIAABCDEFGHIJKLMNOP')
  assert.equal(totalHits(result.hits), 2)
  assert.equal(new Set(result.hits.map((hit) => hit.name)).size, 2)
  assert.ok(RULE_NAMES.length >= 8)
})
