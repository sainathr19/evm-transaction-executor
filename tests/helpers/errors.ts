import { ConfigError } from '../../src/config/error'

/** Runs fn and returns the ConfigError it throws. Fails the test on any other outcome. */
export function expectConfigError(fn: () => unknown): ConfigError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected a ConfigError, but nothing was thrown')
}
