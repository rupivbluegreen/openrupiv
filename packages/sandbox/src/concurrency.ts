/**
 * Bounded concurrency gate for jail execution (ADR-0007: "supervisor-level
 * concurrency cap of 4 simultaneous jails ... requests beyond the cap queue
 * up to a small bounded depth and are then rejected outright rather than
 * queued unboundedly -- an unbounded queue would itself be a DoS vector").
 *
 * acquire() resolves with a release() function once a slot is free. If all
 * slots are busy AND the wait queue is already at maxQueueDepth, acquire()
 * rejects immediately with SandboxAtCapacityError (fail fast, never queue
 * unboundedly). Each release() frees its slot exactly once (double-call
 * guarded) and hands it to the next waiter (FIFO) if any.
 */

export class SandboxAtCapacityError extends Error {
  constructor(
    message = "sandbox at capacity: all execution slots busy and the wait queue is full",
  ) {
    super(message);
    this.name = "SandboxAtCapacityError";
  }
}

type Waiter = (release: () => void) => void;

export class ExecutionSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueDepth: number,
  ) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
    if (maxQueueDepth < 0) throw new Error("maxQueueDepth must be >= 0");
  }

  /** Resolves with a release fn when a slot is free; rejects with
   * SandboxAtCapacityError if all slots are busy and the queue is full. */
  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.queue.length < this.maxQueueDepth) {
      return new Promise<() => void>((resolve) => {
        this.queue.push((release) => resolve(release));
      });
    }
    return Promise.reject(new SandboxAtCapacityError());
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Hand this slot directly to the next waiter; active count is
        // unchanged (the slot is transferred, not freed then reacquired).
        next(this.makeRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}
