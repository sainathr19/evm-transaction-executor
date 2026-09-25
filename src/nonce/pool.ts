/**
 * The nonces available to one (chain, sender): nonces given back by rollback, plus the top, the next
 * nonce never used. Adapted from the Rust pool described in ADR 0009.
 *
 * None of the methods awaits, so Node runs each one without interruption and no lock is needed.
 */
export class NoncePool {
  /** Ascending. The last entry is the top; any entry below it is a gap. */
  #availableNonces: number[]
  /** When each gap opened, so the gap filler can wait before taking it. */
  readonly #openedAt = new Map<number, number>()
  readonly #now: () => number

  constructor(top: number, gaps: number[] = [], now: () => number = Date.now) {
    this.#now = now
    this.#availableNonces = [top]
    for (const gap of gaps) this.rollback(gap)
  }

  /**
   * Rebuilds a sender's pool at startup (ADR 0009). `held` are the nonces of unfinished requests
   * that a node may have; every other nonce from `confirmed` up to the top is available.
   */
  static rebuild(
    { confirmed, pending, held }: { confirmed: number; pending: number; held: number[] },
    now: () => number = Date.now,
  ): NoncePool {
    const top = Math.max(confirmed, pending, ...held.map((nonce) => nonce + 1))
    const isHeld = new Set(held)
    const gaps: number[] = []
    for (let nonce = confirmed; nonce < top; nonce++) if (!isHeld.has(nonce)) gaps.push(nonce)
    return new NoncePool(top, gaps, now)
  }

  get top(): number {
    return this.#availableNonces[this.#availableNonces.length - 1]
  }

  get gaps(): number[] {
    return this.#availableNonces.slice(0, -1)
  }

  /** The smallest available nonce, so gaps are filled before new nonces are used. */
  take(): number {
    const nonce = this.#availableNonces.shift()!
    this.#openedAt.delete(nonce)
    if (this.#availableNonces.length === 0) this.#availableNonces.push(nonce + 1)
    return nonce
  }

  /** Only call this when no node can have a transaction with this nonce (ADR 0009). */
  rollback(nonce: number): void {
    if (nonce >= this.top || this.#availableNonces.includes(nonce)) return
    this.#availableNonces.push(nonce)
    this.#availableNonces.sort((a, b) => a - b)
    this.#openedAt.set(nonce, this.#now())
    this.#mergeIntoTop()
  }

  /** Drops every available nonce the chain has already used. */
  reset(confirmed: number): void {
    this.#availableNonces = this.#availableNonces.filter((nonce) => nonce >= confirmed)
    for (const nonce of this.#openedAt.keys()) if (nonce < confirmed) this.#openedAt.delete(nonce)
    if (this.#availableNonces.length === 0) this.#availableNonces.push(confirmed)
  }

  /** Whether the lowest gap has been open for at least `minAgeMs`. */
  hasGap(minAgeMs: number): boolean {
    if (this.#availableNonces.length < 2) return false
    return this.#now() - this.#openedAt.get(this.#availableNonces[0])! >= minAgeMs
  }

  /** Takes the lowest gap once it has been open for at least `minAgeMs`. Never returns the top. */
  takeGap(minAgeMs: number): number | undefined {
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
