// Cold checkouts share one object database. Serializing preparation avoids
// concurrent lazy fetches downloading the same large pack before either lands.
const tails = new Map<string, Promise<void>>();

export async function withMirrorPreparation<T>(mirror: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const previous = tails.get(mirror) ?? Promise.resolve();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => ready);
  tails.set(mirror, tail);
  void tail.then(() => { if (tails.get(mirror) === tail) tails.delete(mirror); });
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      previous.then(resolve);
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    return await run();
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    release();
  }
}
