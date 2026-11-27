import { Deferred, Effect, Exit, Fiber, FiberSet, Scope, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import * as StreamedResponse from "../../src/internal/streamedResponse.ts";
import { describe, expect, it } from "../support/EffectTest.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Starts reading `stream` as the body of a response, and reports how it
 * ended: with the body it kept, or discarded.
 */
const start = Effect.fnUntraced(function* (
  stream: Stream.Stream<Uint8Array, unknown>,
  options?: {
    readonly maxBytes?: number;
    readonly fibers?: FiberSet.FiberSet<unknown, unknown>;
  },
) {
  const fibers = options?.fibers ?? (yield* FiberSet.make());
  const outcome = yield* Deferred.make<string>();
  // The scope the stream's resources live in, and how it was closed.
  const scope = yield* Scope.make();
  const closed = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
  yield* Scope.addFinalizerExit(scope, (exit) =>
    Deferred.succeed(closed, exit),
  );
  const streamed = yield* StreamedResponse.make({
    response: HttpServerResponse.stream(stream, {
      status: 201,
      contentType: "text/plain",
      headers: { "x-receipt": "yes" },
    }),
    maxBytes: options?.maxBytes ?? 1024,
    fibers,
    onEnd: (body) => Deferred.succeed(outcome, decoder.decode(body)),
    onDiscard: Effect.asVoid(Deferred.succeed(outcome, "discarded")),
    abandonAfter: Effect.sleep("1 minute"),
    scope,
  });
  const body = streamed.response.body;
  if (body._tag !== "Stream") throw new Error("The body is not a stream");
  return {
    response: streamed.response,
    /** The body as the client receives it. */
    body: body.stream,
    detach: streamed.detach,
    outcome: Deferred.await(outcome),
    isDone: Deferred.isDone(outcome),
    /** How the stream's scope was closed, once it is. */
    closed: Deferred.await(closed),
    isClosed: Deferred.isDone(closed),
  };
});

const text = (...chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk)));

const read = (body: Stream.Stream<Uint8Array, unknown>) =>
  Stream.mkString(Stream.decodeText(body));

/** An endless stream of `x`, counting how many it has given. */
const endless = () => {
  const counter = { pulled: 0 };
  const stream = Stream.fromEffectRepeat(
    Effect.sync(() => {
      counter.pulled++;
      return encoder.encode("x");
    }),
  );
  return { counter, stream };
};

/** Lets the fibers that are ready run. */
const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

describe("StreamedResponse", () => {
  it.effect("sends the response as it was, with the same body", () =>
    Effect.gen(function* () {
      const streamed = yield* start(text("receipt ", "for ", "pay_1"));

      expect(streamed.response.status).toBe(201);
      expect(streamed.response.headers["content-type"]).toBe("text/plain");
      expect(streamed.response.headers["x-receipt"]).toBe("yes");
      expect(yield* read(streamed.body)).toBe("receipt for pay_1");
      expect(yield* streamed.outcome).toBe("receipt for pay_1");
    }),
  );

  it.effect("copies each chunk, so a stream can reuse its buffer", () =>
    Effect.gen(function* () {
      // A `Buffer`, whose `slice` shares its memory.
      const buffer = Buffer.from("a");
      const streamed = yield* start(
        Stream.concat(
          Stream.succeed(buffer),
          Stream.fromEffect(
            Effect.sync(() => {
              buffer.write("b");
              return buffer;
            }),
          ),
        ),
      );
      // Both chunks are queued before the client reads the first.
      yield* settle;
      expect(yield* read(streamed.body)).toBe("ab");
      expect(yield* streamed.outcome).toBe("ab");
    }),
  );

  it.effect(
    "keeps the stream's scope open after the client goes, until the stream ends",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const streamed = yield* start(
          Stream.concat(
            text("a"),
            Stream.fromEffect(
              Effect.as(Deferred.await(gate), encoder.encode("b")),
            ),
          ),
        );
        expect(yield* read(Stream.take(streamed.body, 1))).toBe("a");
        yield* settle;
        expect(yield* streamed.isClosed).toBe(false);

        yield* Deferred.succeed(gate, undefined);
        expect(yield* streamed.outcome).toBe("ab");
        expect(yield* streamed.closed).toEqual(Exit.void);
      }),
  );

  it.effect(
    "closes the stream's scope with the failure of a stream that fails",
    () =>
      Effect.gen(function* () {
        const streamed = yield* start(Stream.fail("the ledger is down"));
        yield* streamed.detach;
        expect(yield* streamed.outcome).toBe("discarded");
        expect(yield* streamed.closed).toEqual(Exit.fail("the ledger is down"));
      }),
  );

  it.effect("waits for the client while it reads", () =>
    Effect.gen(function* () {
      const { counter, stream } = endless();
      yield* start(stream);
      yield* settle;
      // The queue is full and nobody reads it, so the stream waits.
      expect(counter.pulled).toBeLessThan(50);
    }),
  );

  it.effect("reads the stream to the end when the client stops early", () =>
    Effect.gen(function* () {
      const streamed = yield* start(text("a", "b", "c"));
      expect(yield* read(Stream.take(streamed.body, 1))).toBe("a");
      expect(yield* streamed.outcome).toBe("abc");
    }),
  );

  it.effect("reads the stream to the end when it is detached unread", () =>
    Effect.gen(function* () {
      const chunks = Array.from({ length: 100 }, () => "x");
      const streamed = yield* start(text(...chunks));
      yield* streamed.detach;
      expect(yield* streamed.outcome).toBe("x".repeat(100));
    }),
  );

  it.effect("discards a stream that fails, and fails the client's", () =>
    Effect.gen(function* () {
      const streamed = yield* start(
        Stream.concat(text("receipt "), Stream.fail("the ledger is down")),
      );
      const client = yield* Effect.exit(read(streamed.body));

      expect(client).toEqual(Exit.fail("the ledger is down"));
      expect(yield* streamed.outcome).toBe("discarded");
    }),
  );

  it.effect("sends a body over the limit whole, then discards it", () =>
    Effect.gen(function* () {
      const streamed = yield* start(text("0123456789", "abc"), {
        maxBytes: 10,
      });
      expect(yield* read(streamed.body)).toBe("0123456789abc");
      expect(yield* streamed.outcome).toBe("discarded");
    }),
  );

  it.effect("keeps a body of exactly the limit", () =>
    Effect.gen(function* () {
      const streamed = yield* start(text("01234", "56789"), { maxBytes: 10 });
      yield* streamed.detach;
      expect(yield* streamed.outcome).toBe("0123456789");
    }),
  );

  it.effect(
    "stops reading a stream nobody reads once it is over the limit",
    () =>
      Effect.gen(function* () {
        const { counter, stream } = endless();
        const streamed = yield* start(stream, { maxBytes: 10 });
        yield* streamed.detach;

        expect(yield* streamed.outcome).toBe("discarded");
        const pulled = counter.pulled;
        yield* settle;
        expect(counter.pulled).toBe(pulled);
      }),
  );

  it.effect("stops reading a stream nobody reads when it is abandoned", () =>
    Effect.gen(function* () {
      const streamed = yield* start(
        Stream.map(Stream.tick("1 second"), () => encoder.encode("x")),
      );
      yield* streamed.detach;

      yield* TestClock.adjust("59 seconds");
      expect(yield* streamed.isDone).toBe(false);
      yield* TestClock.adjust("1 second");
      expect(yield* streamed.outcome).toBe("discarded");
      expect(Exit.hasInterrupts(yield* streamed.closed)).toBe(true);
    }),
  );

  it.effect("does not abandon a stream the client still reads", () =>
    Effect.gen(function* () {
      const streamed = yield* start(
        Stream.take(
          Stream.map(Stream.tick("1 minute"), () => encoder.encode("x")),
          3,
        ),
      );
      const client = yield* Effect.forkChild(read(streamed.body));
      yield* TestClock.adjust("5 minutes");
      expect(yield* Fiber.await(client)).toEqual(Exit.succeed("xxx"));
      expect(yield* streamed.outcome).toBe("xxx");
    }),
  );

  it.effect("discards the stream when its fibers are interrupted", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fibers = yield* Scope.provide(FiberSet.make(), scope);
      const streamed = yield* start(Stream.never, { fibers });

      yield* Scope.close(scope, Exit.void);
      expect(yield* streamed.outcome).toBe("discarded");
    }),
  );
});
