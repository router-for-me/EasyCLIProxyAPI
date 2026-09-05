export function createRefreshScheduler(minIntervalMs = 1_000) {
  type Task = () => Promise<void>;
  type Completion = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  let running = false;
  let completedAt = -Infinity;
  let pending: Task | null = null;
  let urgent = false;
  let completion: Completion | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = () => {
    if (running || !pending) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const delay = urgent ? 0 : Math.max(0, minIntervalMs - (performance.now() - completedAt));
    if (delay > 0) {
      timer = setTimeout(pump, delay);
      return;
    }
    const task = pending;
    const currentCompletion = completion!;
    pending = null;
    completion = null;
    urgent = false;
    running = true;
    void (async () => {
      try {
        await task();
        currentCompletion.resolve();
      } catch (error) {
        currentCompletion.reject(error);
      } finally {
        running = false;
        completedAt = performance.now();
        pump();
      }
    })();
  };

  return {
    schedule(task: Task, immediate = false): Promise<void> {
      pending = task;
      urgent ||= immediate;
      if (!completion) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((onResolved, onRejected) => {
          resolve = onResolved;
          reject = onRejected;
        });
        completion = { promise, resolve, reject };
      }
      const result = completion.promise;
      pump();
      return result;
    },
    cancelPending() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      urgent = false;
      completion?.resolve();
      completion = null;
    },
  };
}
