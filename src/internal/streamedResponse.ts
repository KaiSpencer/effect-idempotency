import { Deferred, Effect, Exit, FiberSet, Queue, Scope, Stream } from "effect";
import { HttpBody, HttpServerResponse } from "effect/http";

/**
 * Reads a streamed response to the end, whether or not its client stays to
 * receive it, so that it can be stored like a response in memory.
 *
 * The server reads the body of a response after the middleware has returned,
 * and stops when the client goes. Reading the handler's stream there would
 * stop the stream too, part way through the work it does, and leave nothing
 * to store, so a retry would run the handler again. Instead a fiber of the
 * middleware's own reads the stream and hands each chunk to the client
 * through a queue, keeping a copy:
 *
 * - While the client reads, the queue is small, so the stream goes at the
 *   client's pace, as it would without the middleware.
 * - When the client goes, or the response it is sent is another one, the
 *   queue is shut down and the fiber reads on alone, keeping the copy only.
 * - When the stream ends within `maxBytes`, `onEnd` gets the copy. When it
 *   fails, or goes over `maxBytes`, `onDiscard` runs.
 *
 * A stream nobody reads is not read for ever: once the client has gone, the
 * fiber stops when the stream goes over `maxBytes`, since it cannot be stored,
 * or when `abandonAfter` ends, and `onDiscard` runs.
 *
 * What the stream reads from, such as a database cursor the handler opened,
 * lives in `scope`. The server would close the request's scope when the
 * client goes, so the stream gets a scope of its own, which the fiber closes
 * once it has finished with the stream.
 */
export interface Options {
  /** A response whose body is a stream. */
  readonly response: HttpServerResponse.HttpServerResponse;
  /** The largest body that is kept. */
  readonly maxBytes: number;
  /** Where the fiber that reads the stream runs. */
  readonly fibers: FiberSet.FiberSet<unknown, unknown>;
  /** Gets the body once the stream has ended, if it is within `maxBytes`. */
  readonly onEnd: (body: Uint8Array) => Effect.Effect<void>;
  /** Runs when the stream fails, is stopped, or goes over `maxBytes`. */
  readonly onDiscard: Effect.Effect<void>;
  /**
   * The scope the stream's resources live in. It is closed after `onEnd` or
   * `onDiscard`, with how the reading ended.
   */
  readonly scope: Scope.Closeable;
  /**
   * Starts when the client goes, and ends when reading on without it is no
   * longer worth it.
   */
  readonly abandonAfter: Effect.Effect<void>;
}

export interface StreamedResponse {
  /** The response to send: the same, with its body read from the copy. */
  readonly response: HttpServerResponse.HttpServerResponse;
  /**
   * Stops handing chunks to the client, which is not going to read them. The
   * stream is still read.
   */
  readonly detach: Effect.Effect<void>;
}

/** How many chunks may wait for the client before the stream waits too. */
const capacity = 16;

export const make = Effect.fnUntraced(function* (
  options: Options,
): Effect.fn.Return<StreamedResponse> {
  const body = options.response.body;
  if (body._tag !== "Stream")
    return yield* Effect.die(new Error("The response body is not a stream"));

  const queue = yield* Queue.bounded<Uint8Array, unknown>(capacity);
  const detached = yield* Deferred.make<void>();
  const overLimit = yield* Deferred.make<void>();

  // Shutting the queue down also resumes an offer that waits for room, which
  // then returns, so the fiber reads on.
  const detachUnsafe = (): void => {
    if (Queue.shutdownUnsafe(queue)) Deferred.doneUnsafe(detached, Exit.void);
  };

  let chunks: Array<Uint8Array> | undefined = [];
  let size = 0;
  const read = Stream.runForEachArray(body.stream, (array) => {
    // Chunks wait in the queue, so the stream could reuse a buffer before the
    // client has read it. Each is copied once, and the client and the stored
    // body share the copy. `new Uint8Array` copies a `Buffer` too, whose
    // `slice` would not.
    const copies = array.map((chunk) => new Uint8Array(chunk));
    if (chunks !== undefined) {
      for (const chunk of copies) {
        size += chunk.length;
        chunks.push(chunk);
      }
      if (size > options.maxBytes) {
        chunks = undefined;
        Deferred.doneUnsafe(overLimit, Exit.void);
      }
    }
    return Queue.offerAll(queue, copies);
  });

  // Ends once nobody reads the response and keeping it is no longer possible
  // or no longer worth it.
  const abandoned = Effect.andThen(
    Deferred.await(detached),
    Effect.raceFirst(Deferred.await(overLimit), options.abandonAfter),
  );

  const settle = (exit: Exit.Exit<boolean, unknown>) => {
    if (Exit.isFailure(exit))
      return Effect.andThen(
        Queue.failCause(queue, exit.cause),
        options.onDiscard,
      );
    // The stream was stopped. The queue is already shut down.
    if (!exit.value) return options.onDiscard;
    const kept = chunks;
    return Effect.andThen(
      Queue.end(queue),
      kept === undefined
        ? options.onDiscard
        : options.onEnd(concat(kept, size)),
    );
  };
  const finish = (exit: Exit.Exit<boolean, unknown>) =>
    Effect.andThen(
      settle(exit),
      Scope.close(
        options.scope,
        Exit.isFailure(exit)
          ? exit
          : exit.value
            ? Exit.void
            : // The stream was stopped part way.
              Exit.interrupt(),
      ),
    );

  yield* FiberSet.run(
    options.fibers,
    Effect.interruptible(
      Effect.raceFirst(Effect.as(read, true), Effect.as(abandoned, false)),
    ).pipe(
      Effect.onExit(finish),
      // `finish` has handed a failure on to the client, whose server reports
      // it, so the fiber itself ends quietly.
      Effect.exit,
    ),
  );

  return {
    response: HttpServerResponse.setBody(
      options.response,
      HttpBody.stream(
        // The server stops reading when the client goes, which ends this
        // stream early and detaches it. When it ends normally the queue is
        // already done, and detaching does nothing.
        Stream.ensuring(Stream.fromQueue(queue), Effect.sync(detachUnsafe)),
        body.contentType,
        body.contentLength,
      ),
    ),
    detach: Effect.sync(detachUnsafe),
  };
});

const concat = (chunks: ReadonlyArray<Uint8Array>, size: number) => {
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
};
