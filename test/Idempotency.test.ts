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

const environment = (store: Layer.Layer<IdempotencyStore.IdempotencyStore>) =>
  Layer.mergeAll(
    Payments.layer.pipe(Layer.provide(store)),
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

const charges = Effect.flatMap(Payments.Ledger, (ledger) => ledger.charges);

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
      yield* ledger.hold;
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
      yield* ledger.hold;
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
      yield* ledger.hold;
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
