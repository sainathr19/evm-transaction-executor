/** A configuration problem that stops the service from starting. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}
