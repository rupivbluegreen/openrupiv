import { describe, expect, it } from "vitest";
import { ExecutionSemaphore, SandboxAtCapacityError } from "../src/concurrency";

/** A promise you can resolve from outside, for asserting on pending state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Races a promise against a microtask flush to check if it's still pending. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol("pending");
  const result = await Promise.race([promise, Promise.resolve(sentinel)]);
  return result === sentinel;
}

describe("ExecutionSemaphore", () => {
  it("constructor rejects maxConcurrent < 1", () => {
    expect(() => new ExecutionSemaphore(0, 1)).toThrow("maxConcurrent must be >= 1");
    expect(() => new ExecutionSemaphore(-1, 1)).toThrow("maxConcurrent must be >= 1");
  });

  it("constructor rejects maxQueueDepth < 0", () => {
    expect(() => new ExecutionSemaphore(1, -1)).toThrow("maxQueueDepth must be >= 0");
  });

  it("acquires up to maxConcurrent immediately, activeCount rises to the cap", async () => {
    const sem = new ExecutionSemaphore(2, 1);
    expect(sem.activeCount).toBe(0);

    const release1 = await sem.acquire();
    expect(sem.activeCount).toBe(1);

    const release2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);

    // cleanup
    release1();
    release2();
  });

  it("queues the (maxConcurrent+1)th acquire and resolves it FIFO once a slot frees", async () => {
    const sem = new ExecutionSemaphore(2, 1);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);
    expect(sem.queuedCount).toBe(0);

    const thirdAcquirePromise = sem.acquire();
    // Give the microtask queue a chance to settle anything that might
    // (incorrectly) resolve immediately.
    await Promise.resolve();
    expect(sem.queuedCount).toBe(1);
    expect(await isPending(thirdAcquirePromise)).toBe(true);

    // Release one of the two active slots -- the queued acquire should now
    // resolve (FIFO: the only waiter gets it), activeCount stays at the cap
    // (slot transferred, not freed then reacquired), queue drains to 0.
    release1();
    const release3 = await thirdAcquirePromise;
    expect(sem.activeCount).toBe(2);
    expect(sem.queuedCount).toBe(0);

    // cleanup
    release2();
    release3();
    expect(sem.activeCount).toBe(0);
  });

  it("FIFO ordering: first waiter queued is first waiter served", async () => {
    const sem = new ExecutionSemaphore(1, 2);
    const release1 = await sem.acquire();
    expect(sem.activeCount).toBe(1);

    const order: string[] = [];
    const waiterA = sem.acquire().then((release) => {
      order.push("A");
      return release;
    });
    await Promise.resolve();
    const waiterB = sem.acquire().then((release) => {
      order.push("B");
      return release;
    });
    await Promise.resolve();
    expect(sem.queuedCount).toBe(2);

    release1();
    const releaseA = await waiterA;
    expect(order).toEqual(["A"]);

    releaseA();
    const releaseB = await waiterB;
    expect(order).toEqual(["A", "B"]);

    releaseB();
  });

  it("rejects with SandboxAtCapacityError when busy and the queue is full, without changing counts", async () => {
    const sem = new ExecutionSemaphore(2, 1);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    // fill the queue to its max depth of 1
    const queuedPromise = sem.acquire();
    await Promise.resolve();
    expect(sem.activeCount).toBe(2);
    expect(sem.queuedCount).toBe(1);

    // one more acquire: all slots busy AND queue full -> reject immediately
    await expect(sem.acquire()).rejects.toThrow(SandboxAtCapacityError);
    expect(sem.activeCount).toBe(2);
    expect(sem.queuedCount).toBe(1);

    // cleanup: release everything so the queued waiter resolves too
    release1();
    const release3 = await queuedPromise;
    release2();
    release3();
  });

  it("release() is idempotent: calling it twice frees only one slot", async () => {
    const sem = new ExecutionSemaphore(2, 1);
    const release1 = await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(2);

    release1();
    expect(sem.activeCount).toBe(1);

    // calling release1 again must not double-free (would otherwise drop
    // activeCount below 0 or hand out a slot that was never actually taken)
    release1();
    expect(sem.activeCount).toBe(1);
  });

  it("after a release with an empty queue, a fresh acquire() succeeds immediately", async () => {
    const sem = new ExecutionSemaphore(1, 1);
    const release1 = await sem.acquire();
    expect(sem.activeCount).toBe(1);

    release1();
    expect(sem.activeCount).toBe(0);
    expect(sem.queuedCount).toBe(0);

    const acquirePromise = sem.acquire();
    expect(await isPending(acquirePromise)).toBe(false);
    const release2 = await acquirePromise;
    expect(sem.activeCount).toBe(1);

    release2();
  });

  it("uses real async handoff via a deferred promise, not fake timers", async () => {
    const sem = new ExecutionSemaphore(1, 1);
    const release1 = await sem.acquire();

    let secondAcquired = false;
    const secondAcquire = sem.acquire().then((release) => {
      secondAcquired = true;
      return release;
    });
    expect(await isPending(secondAcquire)).toBe(true);
    expect(secondAcquired).toBe(false);

    // Simulate the holder of slot 1 doing real async work (a deferred
    // promise it controls) before releasing, rather than releasing
    // synchronously -- proves the handoff is a genuine async resolution,
    // not something that only happens to work under synchronous release.
    const holderWork = deferred<void>();
    const holderDone = holderWork.promise.then(() => {
      release1();
    });
    holderWork.resolve();
    await holderDone;

    const release2 = await secondAcquire;
    expect(secondAcquired).toBe(true);
    release2();
  });
});
