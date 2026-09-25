import pino, { type Logger } from 'pino'

export type { Logger }

// Keys never reach the logger (ADR 0006); redacting these field names is a backstop.
// Signed transactions are redacted too: one that was never broadcast is still valid (ADR 0003).
const REDACT = [
  'privateKey',
  'privateKeys',
  'SIGNER_PRIVATE_KEYS',
  'raw',
  '*.privateKey',
  '*.privateKeys',
  '*.SIGNER_PRIVATE_KEYS',
  '*.raw',
]

export function createLogger(level = 'info'): Logger {
  return pino({ level, redact: { paths: REDACT, censor: '[redacted]' } })
}
