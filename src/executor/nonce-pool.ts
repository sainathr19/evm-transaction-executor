import { type Nonce, nonce } from '../types'

/**
 * The nonces available to one (chain, sender): nonces given back by rollback, plus the top, the next
 * nonce never used. Adapted from the Rust pool described in ADR 0009.
 *
 * None of the methods awaits, so Node runs each one without interruption and no lock is needed.
 */
export class NoncePool {
  /** Ascending. The last entry is the top; any entry below it is a gap. */
  #availableNonces: Nonce[]
  /** When each gap opened, so the gap filler can wait before taking it. */
  readonly #openedAt = new Map<Nonce, number>()
  readonly #now: () => number

  constructor(top: Nonce, gaps: Nonce[] = [], now: () => number = Date.now) {
    this.#now = now
    this.#availableNonces = [top]
    for (const gap of gaps) this.rollback(gap)
  }

  /**
   * Rebuilds a sender's pool at startup (ADR 0009). `held` are the nonces of unfinished requests
   * that a node may have; every other nonce from `confirmed` up to the top is available.
   */
  static rebuild(
    { confirmed, pending, held }: { confirmed: Nonce; pending: Nonce; held: Nonce[] },
    now: () => number = Date.now,
  ): NoncePool {
    const top = nonce(Math.max(confirmed, pending, ...held.map((value) => value + 1)))
    const isHeld = new Set<number>(held)
    const gaps: Nonce[] = []
    for (let value: number = confirmed; value < top; value++) if (!isHeld.has(value)) gaps.push(nonce(value))
    return new NoncePool(top, gaps, now)
  }

  get top(): Nonce {
    return this.#availableNonces[this.#availableNonces.length - 1]
  }

  get gaps(): Nonce[] {
    return this.#availableNonces.slice(0, -1)
  }

  /** The smallest available nonce, so gaps are filled before new nonces are used. */
  take(): Nonce {
    const taken = this.#availableNonces.shift()!
    this.#openedAt.delete(taken)
    if (this.#availableNonces.length === 0) this.#availableNonces.push(nonce(taken + 1))
    return taken
  }

  /** Only call this when no node can have a transaction with this nonce (ADR 0009). */
  rollback(value: Nonce): void {
    if (value >= this.top || this.#availableNonces.includes(value)) return
    this.#availableNonces.push(value)
    this.#availableNonces.sort((a, b) => a - b)
    this.#openedAt.set(value, this.#now())
    this.#mergeIntoTop()
  }

  /** Drops every available nonce the chain has already used. */
  reset(confirmed: Nonce): void {
    this.#availableNonces = this.#availableNonces.filter((value) => value >= confirmed)
    for (const value of this.#openedAt.keys()) if (value < confirmed) this.#openedAt.delete(value)
    if (this.#availableNonces.length === 0) this.#availableNonces.push(confirmed)
  }

  /** Whether the lowest gap has been open for at least `minAgeMs`. */
  hasGap(minAgeMs: number): boolean {
    if (this.#availableNonces.length < 2) return false
    return this.#now() - this.#openedAt.get(this.#availableNonces[0])! >= minAgeMs
  }

  /** Takes the lowest gap once it has been open for at least `minAgeMs`. Never returns the top. */
  takeGap(minAgeMs: number): Nonce | undefined {
    return this.hasGap(minAgeMs) ? this.take() : undefined
  }

  // While the nonce below the top is available, it becomes the new top: {6, 7, 8} → {6}.
  #mergeIntoTop(): void {
    const available = this.#availableNonces
    while (available.length >= 2 && available[available.length - 2] === available[available.length - 1] - 1) {
      available.pop()
      this.#openedAt.delete(available[available.length - 1])
    }
  }
}
