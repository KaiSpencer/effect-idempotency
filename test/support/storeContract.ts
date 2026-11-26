/**
 * What every `IdempotencyStore` must do. A store's test file calls
 * `storeContract` with its layer, and each test runs against a fresh build
 * of it under the test clock.
 */
import { Duration, Effect, type Layer } from "effect";
import { TestClock } from "effect/testing";
import { IdempotencyKey, IdempotencyStore } from "../../src/index.ts";
import { describe, expect, it } from "./EffectTest.ts";

const lockExpiry = Duration.minutes(5);
const retention = Duration.hours(24);

const response: IdempotencyStore.StoredResponse = {
  status: 201,
  headers: { "content-type": "application/json" },
  cookies: ["session=abc; Path=/"],
  body: new Uint8Array([123, 125]),
};

const claim = (
  key: string,
  options?: { scope?: string; fingerprint?: string },
) =>
  Effect.flatMap(IdempotencyStore.IdempotencyStore, (store) =>
    store.claim({
      scope: options?.scope ?? "scope",
      key: IdempotencyKey.IdempotencyKey.make(key),
      fingerprint: IdempotencyStore.Fingerprint.make(
        options?.fingerprint ?? "fingerprint",
      ),
      lockExpiry,
    }),
  );

/** Claims a free key and returns the claim. */
const claimed = (key: string) =>
  Effect.flatMap(claim(key), (result) =>
    result._tag === "Claimed"
      ? Effect.succeed(result.claim)
      : Effect.die(new Error(`Expected to claim "${key}", got ${result._tag}`)),
  );

export const storeContract = (
  name: string,
  layer: Layer.Layer<IdempotencyStore.IdempotencyStore>,
): void => {
  const test = <A, E>(
    label: string,
    self: () => Effect.Effect<A, E, IdempotencyStore.IdempotencyStore>,
  ): void => {
    it.effect(label, () => Effect.provide(Effect.suspend(self), layer));
  };

  describe(`${name}: store contract`, () => {
    test("claims a free key", () =>
      Effect.gen(function* () {
        expect(yield* claim("k")).toMatchObject({
          _tag: "Claimed",
          claim: { scope: "scope", key: "k" },
        });
      }));

    test("reports a claimed key as in progress, with its fingerprint", () =>
      Effect.gen(function* () {
        yield* claimed("k");
        expect(yield* claim("k", { fingerprint: "other" })).toEqual({
          _tag: "InProgress",
          fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
        });
      }));

    test("gives exactly one of many concurrent claims the key", () =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          Array.from({ length: 100 }, () => claim("k")),
          { concurrency: "unbounded" },
        );
        expect(
          results.filter((result) => result._tag === "Claimed"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result._tag === "InProgress"),
        ).toHaveLength(99);
      }));

    test("returns the stored response once a claim is completed", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        yield* store.complete(yield* claimed("k"), response, retention);
        expect(yield* claim("k", { fingerprint: "other" })).toEqual({
          _tag: "Completed",
          fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
          response,
        });
      }));

    test("frees a released key", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        yield* store.release(yield* claimed("k"));
        expect((yield* claim("k"))._tag).toBe("Claimed");
      }));

    test("keeps the same key in two scopes apart", () =>
      Effect.gen(function* () {
        expect((yield* claim("k", { scope: "alice" }))._tag).toBe("Claimed");
        expect((yield* claim("k", { scope: "bob" }))._tag).toBe("Claimed");
        expect((yield* claim("k", { scope: "alice" }))._tag).toBe("InProgress");
      }));

    test("does not confuse a scope and key that join to the same text", () =>
      Effect.gen(function* () {
        expect((yield* claim("b:c", { scope: "a" }))._tag).toBe("Claimed");
        expect((yield* claim("c", { scope: "a:b" }))._tag).toBe("Claimed");
        expect((yield* claim('b","c', { scope: "a" }))._tag).toBe("Claimed");
        expect((yield* claim("c", { scope: 'a","b' }))._tag).toBe("Claimed");
      }));

    test("holds a claim until the lock expires, then frees the key", () =>
      Effect.gen(function* () {
        yield* claimed("k");
        yield* TestClock.adjust(
          Duration.subtract(lockExpiry, Duration.millis(1)),
        );
        expect((yield* claim("k"))._tag).toBe("InProgress");
        yield* TestClock.adjust(Duration.millis(1));
        expect((yield* claim("k"))._tag).toBe("Claimed");
      }));

    test("stores a completion that comes after the lock expired, if nobody took the key", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* TestClock.adjust(Duration.times(lockExpiry, 3));
        yield* store.complete(first, response, retention);
        expect((yield* claim("k"))._tag).toBe("Completed");
      }));

    test("releases a claim whose lock expired, if nobody took the key", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* TestClock.adjust(Duration.times(lockExpiry, 3));
        yield* store.release(first);
        expect((yield* claim("k"))._tag).toBe("Claimed");
      }));

    test("does not let an expired claim complete or release its successor", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* TestClock.adjust(lockExpiry);
        const second = yield* claimed("k");

        yield* store.complete(first, response, retention);
        expect((yield* claim("k"))._tag).toBe("InProgress");
        yield* store.release(first);
        expect((yield* claim("k"))._tag).toBe("InProgress");

        yield* store.complete(second, response, retention);
        expect((yield* claim("k"))._tag).toBe("Completed");
      }));

    test("keeps a response for the retention, counted from its completion", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* TestClock.adjust("1 minute");
        yield* store.complete(first, response, retention);
        yield* TestClock.adjust(
          Duration.subtract(retention, Duration.millis(1)),
        );
        expect((yield* claim("k"))._tag).toBe("Completed");
        yield* TestClock.adjust(Duration.millis(1));
        expect((yield* claim("k"))._tag).toBe("Claimed");
      }));

    test("does not release a completed key", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* store.complete(first, response, retention);
        yield* store.release(first);
        expect((yield* claim("k"))._tag).toBe("Completed");
      }));
  });
};
