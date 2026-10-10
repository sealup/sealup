// SFTP requests in flight on one channel: at most `limit` requests at once across all files (the
// channel's share of the target's `parallel`, which grows when another channel is lost), each
// with its own timeout (R21). A request that the server answers with an SFTP status fails with a
// StatusError, so the Session can decide what that status means for its operation
// (a missing file for `remove` is done); a request that gets no answer fails with `timeout`, and
// one that cannot get an answer any more fails with `connection-lost`.

import { TransportError } from '../contracts/index.ts';

/** An SFTP status answer (v3 codes, plus the v5+ quota codes some servers send anyway). */
export class StatusError extends Error {
  override readonly name = 'StatusError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Done<T> = (error: Error | null | undefined, value?: T) => void;

export interface Requests {
  /** Sends one request when a slot is free (first come, first served) and waits for its answer. */
  send<T>(call: (done: Done<T>) => void): Promise<T>;
  /** Like send, but `work` holds the slot: it may read the disk first, then send through `send`. */
  slot<T>(work: (send: <U>(call: (done: Done<U>) => void) => Promise<U>) => Promise<T>): Promise<T>;
  /** Every request waiting or in flight fails with connection-lost, and so does every later one. */
  lose(): void;
  readonly lost: boolean;
  /** Requests (and slots) waiting or in flight: how busy the channel is. */
  readonly load: number;
  /** How many requests may be in flight at once; raising it sends waiting ones at once. */
  limit: number;
}

export function createRequests(parallel: number, timeoutMs: number): Requests {
  let limit = parallel;
  let active = 0;
  const queue: (() => void)[] = [];
  const pending = new Set<(error: Error) => void>();
  let lost = false;

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  };
  /** Hands free slots to the waiting requests, first come, first served. */
  const drain = (): void => {
    while (active < limit) {
      const next = queue.shift();
      if (next === undefined) return;
      active++;
      next();
    }
  };
  const release = (): void => {
    active--;
    drain();
  };

  /** One request on the wire: answered, timed out, or lost. Holds no slot itself. */
  const wire = <T>(call: (done: Done<T>) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (lost) return reject(connectionLost());
      let settled = false;
      const finish = (error: Error | undefined, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(finish);
        if (error === undefined) resolve(value as T);
        else reject(error);
      };
      const timer = setTimeout(() => {
        finish(new TransportError('timeout', 'no-answer', { timeoutMs }));
      }, timeoutMs);
      pending.add(finish);
      try {
        call((error, value) => finish(error ? answerError(error) : undefined, value));
      } catch (error) {
        // ssh2 throws at once when the channel is gone.
        finish(error instanceof Error ? answerError(error) : connectionLost(error));
      }
    });

  const slot: Requests['slot'] = async (work) => {
    if (lost) throw connectionLost();
    // Taken synchronously when free, so requests leave in the order they were asked for.
    await acquire();
    try {
      return await work(wire);
    } finally {
      release();
    }
  };

  return {
    send: (call) => slot((send) => send(call)),
    slot,
    lose() {
      lost = true;
      for (const finish of [...pending]) finish(connectionLost());
    },
    get lost() {
      return lost;
    },
    get load() {
      return active + queue.length;
    },
    get limit() {
      return limit;
    },
    set limit(value) {
      limit = Math.max(1, value);
      drain();
    },
  };
}

/** An error ssh2 hands a request callback: an SFTP status, or the connection is gone. */
function answerError(error: Error): Error {
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === 'number') return new StatusError(code, error.message);
  if (error instanceof TransportError) return error;
  return connectionLost(error);
}

/** The connection is gone; `cause` is what ssh2 said about it, for `--debug`. */
export function connectionLost(cause?: unknown): TransportError {
  return new TransportError('connection-lost', 'lost', cause === undefined ? {} : { cause });
}
