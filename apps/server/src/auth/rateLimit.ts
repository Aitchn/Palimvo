/** Counts failures per key in a sliding window; in memory, which is enough for one server process. */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Seconds until another attempt is allowed, or 0 when the key is not blocked. */
  retryAfterSeconds(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    const oldest = list[list.length - this.max] ?? list[0]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    // Keep memory bounded when many different keys fail once.
    if (this.hits.size > 10_000) {
      for (const k of this.hits.keys()) {
        this.recent(k);
        if (this.hits.size <= 5_000) break;
      }
    }
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

/** Counts every call per key in a sliding window, with the limit given per call. */
export class RateWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  /** Records a call; returns 0 when allowed, otherwise the seconds to wait (nothing is recorded). */
  hit(key: string, max: number, now: number): number {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= max) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil(((list[0] as number) + this.windowMs - now) / 1000));
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (!v.some((t) => t > cutoff)) this.hits.delete(k);
      }
    }
    return 0;
  }
}
