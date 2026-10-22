/** Runs async tasks one at a time per key, in arrival order. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Resolves once every queued task (including ones queued while waiting) has finished. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all(this.tails.values());
  }
}

/**
 * A readers-writer lock per key (a vault): `exclusive` tasks run alone, one at a time; `shared`
 * tasks run alongside each other, one at a time per sub-key (a file). Arrival order is kept
 * between the two kinds, so an exclusive task waits for the shared ones queued before it, and
 * shared ones queued after it wait for it.
 */
export class SharedExclusiveMutex {
  private readonly keys = new Map<
    string,
    { barrier: Promise<void>; shared: Set<Promise<void>>; files: KeyedMutex }
  >();
  private readonly all = new Set<Promise<void>>();

  shared<T>(key: string, sub: string, task: () => Promise<T>): Promise<T> {
    const state = this.state(key);
    const result = state.barrier.then(() => state.files.run(sub, task));
    const settled = this.track(result);
    state.shared.add(settled);
    void settled.then(() => {
      state.shared.delete(settled);
      this.cleanup(key, state);
    });
    return result;
  }

  exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const state = this.state(key);
    const prior = Promise.all([state.barrier, ...state.shared]);
    const result = prior.then(task);
    const settled = this.track(result);
    state.barrier = settled;
    void settled.then(() => this.cleanup(key, state));
    return result;
  }

  /** Resolves once every queued task (including ones queued while waiting) has finished. */
  async idle(): Promise<void> {
    while (this.all.size > 0) await Promise.all(this.all);
  }

  private state(key: string) {
    let state = this.keys.get(key);
    if (!state)
      this.keys.set(
        key,
        (state = { barrier: Promise.resolve(), shared: new Set(), files: new KeyedMutex() }),
      );
    return state;
  }

  private track(result: Promise<unknown>): Promise<void> {
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.all.add(settled);
    void settled.then(() => this.all.delete(settled));
    return settled;
  }

  private cleanup(
    key: string,
    state: { barrier: Promise<void>; shared: Set<Promise<void>> },
  ): void {
    // Forget a key once nothing is queued on it; a later task starts a fresh state.
    if (state.shared.size === 0 && this.keys.get(key) === state) {
      const barrier = state.barrier;
      void barrier.then(() => {
        if (state.shared.size === 0 && state.barrier === barrier && this.keys.get(key) === state)
          this.keys.delete(key);
      });
    }
  }
}
