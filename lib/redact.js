/**
 * Conservative secret redaction applied before a note reaches disk.
 *
 * Rules require long, structured values so ordinary prose is not mangled.
 * Redaction is a backstop, not a guarantee: the tool description tells the
 * model not to record secrets in the first place.
 */

export const REDACT_MARK = '***[redacted]'

const RULES = [
  {
    name: 'pem-private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    keep: 0,
  },
  { name: 'sk-token', re: /\bsk-[A-Za-z0-9_-]{20,}/g, keep: 6 },
  { name: 'aliyun-ak', re: /\bLTAI[A-Za-z0-9]{12,}\b/g, keep: 4 },
  { name: 'aws-ak', re: /\bAKIA[A-Z0-9]{16}\b/g, keep: 4 },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, keep: 7 },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, keep: 6 },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, keep: 7 },
  {
    name: 'kv-secret',
    re: /\b(api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{16,})["']?/gi,
    keep: -1,
  },
]

function mask(value, keep) {
  if (keep <= 0 || value.length <= keep) return REDACT_MARK
  return value.slice(0, keep) + REDACT_MARK
}

/** @returns {{ text: string, hits: Array<{ name: string, count: number }> }} */
export function redact(text) {
  let value = String(text ?? '')
  if (!value) return { text: value, hits: [] }
  const hits = []
  for (const rule of RULES) {
    let count = 0
    value = value.replace(rule.re, (...args) => {
      count++
      if (rule.name === 'kv-secret') {
        return `${args[1]}=${REDACT_MARK}`
      }
      return mask(args[0], rule.keep)
    })
    if (count > 0) hits.push({ name: rule.name, count })
  }
  return { text: value, hits }
}

export function totalHits(hits) {
  return (hits ?? []).reduce((sum, hit) => sum + (Number(hit?.count) || 0), 0)
}

export const RULE_NAMES = RULES.map((rule) => rule.name)
