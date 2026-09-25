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

/** Awaits the promise and returns the ConfigError it rejects with. Fails the test otherwise. */
export async function expectConfigErrorAsync(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected a ConfigError, but the promise resolved')
}
