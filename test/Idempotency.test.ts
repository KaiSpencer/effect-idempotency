/**
 * The middleware through the whole `HttpApi` pipeline, with a typed client
 * and no socket. The client can only send a well-formed key, so header values
 * a client should not send, and what the bytes on the wire look like, are
 * `test/e2e`'s job.
 */
import { Effect, Fiber, Layer, type Scope } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest, OpenApi } from "effect/http-api";
import { TestClock } from "effect/testing";
import { IdempotencyKey, IdempotencyStore } from "../src/index.ts";
import * as memoryStore from "../src/internal/memoryStore.ts";
import * as Payments from "./fixtures/Payments.ts";
import {
  describe,
  expect,
  it,
  test as plainTest,
  type TestServices,
} from "./support/EffectTest.ts";

const environment = (
  store: Layer.Layer<IdempotencyStore.IdempotencyStore>,
  options?: Parameters<typeof Payments.layerWith>[0],
) =>
  Layer.mergeAll(
    Payments.layerWith(options).pipe(Layer.provide(store)),
    HttpServer.layerServices,
  );

const client = HttpApiTest.groups(Payments.Api, ["payments", "control"]);

/** Creates a payment as `alice` with the key `k1` unless told otherwise. */
const create = (
  amount: number,
  options?: { key?: string | undefined; user?: string },
) => {
  const key = options !== undefined && "key" in options ? options.key : "k1";
  return Effect.flatMap(client, (api) =>
    api.payments.create({
      payload: { amount },
      headers: {
        "x-user": options?.user ?? "alice",
        "idempotency-key":
          key === undefined
            ? undefined
            : IdempotencyKey.IdempotencyKey.make(key),
      },
    }),
  );
};

/** A receipt, which the handler streams, as `alice` with the key `k1`. */
const receipt = (amount: number) =>
  Effect.flatMap(client, (api) =>
    api.payments.receipt({
      payload: { amount },
      headers: {
        "x-user": "alice",
        "idempotency-key": IdempotencyKey.IdempotencyKey.make("k1"),
      },
    }),
  );

/**
 * A receipt once the one before it has ended. A streamed response is stored
 * when the middleware has read it to the end, which can be just after the
 * client has.
 */
const receiptOnceSettled = (amount: number) =>
  receipt(amount).pipe(
    Effect.retry({
      while: (error) => error._tag === "IdempotencyKeyInProgress",
    }),
  );

const charges = Effect.flatMap(Payments.Ledger, (ledger) => ledger.charges);

/**
 * Makes charges wait until `resume`, or until the test ends: a failed
 * assertion must not leave a charge waiting, because the request around it
 * cannot be interrupted.
 */
const holdCharges = Effect.flatMap(Payments.Ledger, (ledger) =>
  Effect.acquireRelease(ledger.hold, () => ledger.resume),
);

const withMemoryStore = environment(IdempotencyStore.layerMemory);

describe("Idempotency", () => {
  const test = <A, E>(
    label: string,
    self: () => Effect.Effect<
      A,
      E,
      Layer.Success<typeof withMemoryStore> | TestServices | Scope.Scope
    >,
  ): void => {
    it.effect(label, () =>
      Effect.provide(Effect.suspend(self), withMemoryStore),
    );
  };

  test("runs the handler for a new key", () =>
    Effect.gen(function* () {
      expect(yield* create(5)).toEqual({ id: "pay_1", amount: 5 });
      expect(yield* charges).toBe(1);
    }));

  test("replays the first response to a retry without running the handler", () =>
    Effect.gen(function* () {
      const first = yield* create(5);
      expect(yield* create(5)).toEqual(first);
      expect(yield* create(5)).toEqual(first);
      expect(yield* charges).toBe(1);
    }));

  test("runs the handler once per key", () =>
    Effect.gen(function* () {
      expect((yield* create(5, { key: "k1" })).id).toBe("pay_1");
      expect((yield* create(5, { key: "k2" })).id).toBe("pay_2");
    }));

  test("carries a key with quotes and backslashes through the header codec", () =>
    Effect.gen(function* () {
      const first = yield* create(5, { key: 'a"b\\c' });
      expect(yield* create(5, { key: 'a"b\\c' })).toEqual(first);
      expect((yield* create(5, { key: "abc" })).id).toBe("pay_2");
    }));

  test("fails without a key", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(create(5, { key: undefined }));
      expect(error._tag).toBe("IdempotencyKeyMissing");
      expect(yield* charges).toBe(0);
    }));

  test("fails when the key was used with a different request", () =>
    Effect.gen(function* () {
      yield* create(5);
      const error = yield* Effect.flip(create(6));
      expect(error._tag).toBe("IdempotencyKeyMismatch");
      expect(yield* charges).toBe(1);
    }));

  test("fails while the first request is still running, then replays it", () =>
    Effect.gen(function* () {
      const ledger = yield* Payments.Ledger;
      yield* holdCharges;
      const first = yield* Effect.forkChild(create(5));
      yield* ledger.held;

      const error = yield* Effect.flip(create(5));
      expect(error._tag).toBe("IdempotencyKeyInProgress");

      yield* ledger.resume;
      const payment = yield* Fiber.join(first);
      expect(yield* create(5)).toEqual(payment);
      expect(yield* charges).toBe(1);
    }));

  test("reports a different request before a running one", () =>
    Effect.gen(function* () {
      const ledger = yield* Payments.Ledger;
      yield* holdCharges;
      const first = yield* Effect.forkChild(create(5));
      yield* ledger.held;

      const error = yield* Effect.flip(create(6));
      expect(error._tag).toBe("IdempotencyKeyMismatch");

      yield* ledger.resume;
      yield* Fiber.join(first);
    }));

  test("releases the key when the handler fails, so a retry runs it again", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(create(-1));
      expect(error._tag).toBe("Declined");
      expect((yield* Effect.flip(create(-1)))._tag).toBe("Declined");
      expect(yield* charges).toBe(2);
    }));

  test("releases the key when the handler dies", () =>
    Effect.gen(function* () {
      expect((yield* Effect.exit(create(0)))._tag).toBe("Failure");
      expect((yield* Effect.exit(create(0)))._tag).toBe("Failure");
      expect(yield* charges).toBe(2);
    }));

  test("finishes the handler and stores its response when the request is interrupted", () =>
    Effect.gen(function* () {
      const ledger = yield* Payments.Ledger;
      yield* holdCharges;
      const first = yield* Effect.forkChild(create(5));
      yield* ledger.held;
      const interruption = yield* Effect.forkChild(Fiber.interrupt(first));

      expect((yield* Effect.flip(create(5)))._tag).toBe(
        "IdempotencyKeyInProgress",
      );
      yield* ledger.resume;
      yield* Fiber.join(interruption);

      expect((yield* create(5)).id).toBe("pay_1");
      expect(yield* charges).toBe(1);
    }));

  test("stores the response of a handler that outlives the lock expiry", () =>
    Effect.gen(function* () {
      const ledger = yield* Payments.Ledger;
      yield* holdCharges;
      const first = yield* Effect.forkChild(create(5));
      yield* ledger.held;
      yield* TestClock.adjust("1 hour");
      yield* ledger.resume;

      expect((yield* Fiber.join(first)).id).toBe("pay_1");
      expect((yield* create(5)).id).toBe("pay_1");
      expect(yield* charges).toBe(1);
    }));

  test("replays for the retention, then runs the handler again", () =>
    Effect.gen(function* () {
      yield* create(5);
      yield* TestClock.adjust("23 hours");
      expect((yield* create(5)).id).toBe("pay_1");
      yield* TestClock.adjust("1 hour");
      expect((yield* create(5)).id).toBe("pay_2");
    }));

  test("keeps the same key of two users apart", () =>
    Effect.gen(function* () {
      expect((yield* create(5, { user: "alice" })).id).toBe("pay_1");
      expect((yield* create(5, { user: "bob" })).id).toBe("pay_2");
      expect((yield* create(5, { user: "alice" })).id).toBe("pay_1");
    }));

  test("stores a streamed response once it has ended, and replays it", () =>
    Effect.gen(function* () {
      expect(yield* receipt(5)).toBe("receipt for pay_1");
      expect(yield* receiptOnceSettled(5)).toBe("receipt for pay_1");
      expect(yield* charges).toBe(1);
    }));

  test("releases the key of a streamed response that fails", () =>
    Effect.gen(function* () {
      expect((yield* Effect.exit(receipt(-1)))._tag).toBe("Failure");
      expect((yield* Effect.exit(receiptOnceSettled(-1)))._tag).toBe("Failure");
      expect(yield* charges).toBe(2);
    }));

  test("runs inside the middleware added after it", () =>
    Effect.gen(function* () {
      const api = yield* client;
      const error = yield* Effect.flip(
        api.payments.create({
          payload: { amount: 5 },
          headers: {
            "idempotency-key": IdempotencyKey.IdempotencyKey.make("k1"),
          },
        }),
      );
      expect(error._tag).toBe("Unauthenticated");
    }));
});

describe("Idempotency options", () => {
  it.effect("replays for the retention it is given", () =>
    Effect.gen(function* () {
      yield* create(5);
      yield* TestClock.adjust("59 seconds");
      expect((yield* create(5)).id).toBe("pay_1");
      yield* TestClock.adjust("1 second");
      expect((yield* create(5)).id).toBe("pay_2");
    }).pipe(
      Effect.provide(
        environment(IdempotencyStore.layerMemory, { retention: "1 minute" }),
      ),
    ),
  );

  it.effect(
    "holds a key for the lock expiry it is given, then lets a retry take it",
    () =>
      Effect.gen(function* () {
        const ledger = yield* Payments.Ledger;
        yield* holdCharges;
        const first = yield* Effect.forkChild(create(5));
        yield* ledger.held;

        yield* TestClock.adjust("9 seconds");
        expect((yield* Effect.flip(create(5)))._tag).toBe(
          "IdempotencyKeyInProgress",
        );

        // Past the lock expiry the retry takes the key and runs the handler too.
        yield* TestClock.adjust("1 second");
        yield* ledger.hold;
        const retry = yield* Effect.forkChild(create(5));
        yield* ledger.held;
        expect(yield* charges).toBe(2);

        yield* ledger.resume;
        expect((yield* Fiber.join(first)).id).toBe("pay_1");
        expect((yield* Fiber.join(retry)).id).toBe("pay_2");
        // The retry's claim voided the first one, so its response is the one kept.
        expect((yield* create(5)).id).toBe("pay_2");
      }).pipe(
        Effect.provide(
          environment(IdempotencyStore.layerMemory, {
            lockExpiry: "10 seconds",
          }),
        ),
      ),
  );
});

describe("Idempotency maxStoredBytes", () => {
  // `{"id":"pay_1","amount":5}` is 25 bytes, `receipt for pay_1` 17.
  const withLimit = (maxStoredBytes: number) =>
    Effect.provide(
      environment(IdempotencyStore.layerMemory, { maxStoredBytes }),
    );

  it.effect("stores a response of exactly the limit", () =>
    Effect.gen(function* () {
      yield* create(5);
      expect((yield* create(5)).id).toBe("pay_1");
      expect(yield* charges).toBe(1);
    }).pipe(withLimit(25)),
  );

  it.effect(
    "sends a response over the limit without storing it, and releases its key",
    () =>
      Effect.gen(function* () {
        expect((yield* create(5)).id).toBe("pay_1");
        expect((yield* create(5)).id).toBe("pay_2");
      }).pipe(withLimit(24)),
  );

  it.effect("stores a streamed response of exactly the limit", () =>
    Effect.gen(function* () {
      yield* receipt(5);
      expect(yield* receiptOnceSettled(5)).toBe("receipt for pay_1");
      expect(yield* charges).toBe(1);
    }).pipe(withLimit(17)),
  );

  it.effect(
    "sends a streamed response over the limit whole, and releases its key",
    () =>
      Effect.gen(function* () {
        expect(yield* receipt(5)).toBe("receipt for pay_1");
        expect(yield* receiptOnceSettled(5)).toBe("receipt for pay_2");
      }).pipe(withLimit(16)),
  );
});

describe("Idempotency in OpenAPI", () => {
  const operation = (
    OpenApi.fromApi(Payments.Api) as unknown as {
      paths: Record<
        string,
        {
          post: {
            parameters: ReadonlyArray<{ name: string; in: string }>;
            responses: Record<string, { content: Record<string, unknown> }>;
          };
        }
      >;
    }
  ).paths["/payments"]?.post;

  plainTest("documents the header", () => {
    expect(
      operation?.parameters.map(
        (parameter) => `${parameter.in}: ${parameter.name}`,
      ),
    ).toContain("header: idempotency-key");
  });

  plainTest.each(["400", "409", "422"])(
    "documents the %s problem",
    (status) => {
      expect(Object.keys(operation?.responses[status]?.content ?? {})).toEqual([
        "application/problem+json",
      ]);
    },
  );
});

describe("Idempotency with a failing store", () => {
  const failure = Effect.fail(
    new IdempotencyStore.IdempotencyStoreError({ cause: "down" }),
  );

  const failing = (
    broken: Partial<IdempotencyStore.IdempotencyStore["Service"]>,
  ): Layer.Layer<IdempotencyStore.IdempotencyStore> =>
    Layer.effect(
      IdempotencyStore.IdempotencyStore,
      Effect.map(memoryStore.make, (store) => ({ ...store, ...broken })),
    );

  it.effect("does not run the handler when the key cannot be claimed", () =>
    Effect.gen(function* () {
      expect((yield* Effect.exit(create(5)))._tag).toBe("Failure");
      expect(yield* charges).toBe(0);
    }).pipe(Effect.provide(environment(failing({ claim: () => failure })))),
  );

  it.effect(
    "sends the response when it cannot be stored, and keeps the key claimed",
    () =>
      Effect.gen(function* () {
        expect((yield* create(5)).id).toBe("pay_1");
        expect((yield* Effect.flip(create(5)))._tag).toBe(
          "IdempotencyKeyInProgress",
        );
        expect(yield* charges).toBe(1);
      }).pipe(
        Effect.provide(environment(failing({ complete: () => failure }))),
      ),
  );

  it.effect(
    "fails with the handler's error when the key cannot be released",
    () =>
      Effect.gen(function* () {
        expect((yield* Effect.flip(create(-1)))._tag).toBe("Declined");
      }).pipe(Effect.provide(environment(failing({ release: () => failure })))),
  );
});
