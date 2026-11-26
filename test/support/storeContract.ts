/**
 * What every `IdempotencyStore` must do. A store's test file calls
 * `storeContract` with its layer, and each test runs against a fresh build
 * of it under the test clock.
 */
import { Duration, Effect, type Layer } from "effect";
import { TestClock } from "effect/testing";
import { IdempotencyKey, IdempotencyStore } from "../../src/index.ts";
import { describe, expect, it } from "./EffectTest.ts";
import { agreesWithMemoryStore, lockExpiry } from "./storeModel.ts";

const retention = Duration.hours(24);

const response: IdempotencyStore.StoredResponse = {
  status: 201,
  headers: { "content-type": "application/json" },
  cookies: ["session=abc; Path=/"],
  body: new Uint8Array([123, 125]),
};

/** Every byte value, so that a store which keeps text loses none of them. */
const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);

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

/** Many claims of one key at once, and how many of them got it. */
const race = (key: string) =>
  Effect.map(
    Effect.all(
      Array.from({ length: 100 }, () => claim(key)),
      { concurrency: "unbounded" },
    ),
    (results) => ({
      claimed: results.filter((result) => result._tag === "Claimed").length,
      inProgress: results.filter((result) => result._tag === "InProgress")
        .length,
    }),
  );

export const storeContract = (
  name: string,
  layer: Layer.Layer<IdempotencyStore.IdempotencyStore>,
  options?: {
    /** How many random sequences the last test runs. Defaults to 100. */
    readonly modelRuns?: number;
    /** The time limit of each test, in milliseconds. */
    readonly timeout?: number;
  },
): void => {
  const test = <A, E>(
    label: string,
    self: () => Effect.Effect<A, E, IdempotencyStore.IdempotencyStore>,
  ): void => {
    it.effect(
      label,
      () => Effect.provide(Effect.suspend(self), layer),
      options?.timeout,
    );
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
        expect(yield* race("k")).toEqual({ claimed: 1, inProgress: 99 });
      }));

    // Taking over a key is another path through a store than taking a free
    // one, and the one where two requests are most likely to both win.
    test("gives exactly one of many concurrent claims a key whose lock expired", () =>
      Effect.gen(function* () {
        yield* claimed("k");
        yield* TestClock.adjust(lockExpiry);
        expect(yield* race("k")).toEqual({ claimed: 1, inProgress: 99 });
      }));

    test("gives exactly one of many concurrent claims a key whose response expired", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        yield* store.complete(yield* claimed("k"), response, retention);
        yield* TestClock.adjust(retention);
        expect(yield* race("k")).toEqual({ claimed: 1, inProgress: 99 });
      }));

    test("never lets two claims hold a key while claims and releases race", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        let holders = 0;
        let most = 0;
        let turns = 0;
        const worker = Effect.gen(function* () {
          for (let round = 0; round < 20; round++) {
            const result = yield* claim("k");
            if (result._tag === "Claimed") {
              turns++;
              most = Math.max(most, ++holders);
              yield* Effect.yieldNow;
              holders--;
              yield* store.release(result.claim);
            } else {
              expect(result._tag).toBe("InProgress");
              yield* Effect.yieldNow;
            }
          }
        });
        yield* Effect.all(
          Array.from({ length: 10 }, () => worker),
          { concurrency: "unbounded" },
        );

        expect(most).toBe(1);
        // The key changed hands, so the releases were raced as well.
        expect(turns).toBeGreaterThan(1);
        expect((yield* claim("k"))._tag).toBe("Claimed");
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

    test("does not let a released claim complete or release its successor", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* store.release(first);
        const second = yield* claimed("k");

        yield* store.complete(first, response, retention);
        expect((yield* claim("k"))._tag).toBe("InProgress");
        yield* store.release(first);
        expect((yield* claim("k"))._tag).toBe("InProgress");

        yield* store.complete(second, response, retention);
        expect((yield* claim("k"))._tag).toBe("Completed");
      }));

    test("keeps the same key in two scopes apart", () =>
      Effect.gen(function* () {
        expect((yield* claim("k", { scope: "alice" }))._tag).toBe("Claimed");
        expect((yield* claim("k", { scope: "bob" }))._tag).toBe("Claimed");
        expect((yield* claim("k", { scope: "alice" }))._tag).toBe("InProgress");
      }));

    test("completes and releases a key in its own scope only", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const claimedBy = (scope: string) =>
          Effect.flatMap(claim("k", { scope }), (result) =>
            result._tag === "Claimed"
              ? Effect.succeed(result.claim)
              : Effect.die(new Error(`Expected a claim, got ${result._tag}`)),
          );
        const alice = yield* claimedBy("alice");
        const bob = yield* claimedBy("bob");
        yield* claimedBy("carol");

        yield* store.complete(alice, response, retention);
        expect((yield* claim("k", { scope: "bob" }))._tag).toBe("InProgress");
        yield* store.release(bob);
        expect((yield* claim("k", { scope: "alice" }))._tag).toBe("Completed");
        expect((yield* claim("k", { scope: "carol" }))._tag).toBe("InProgress");
        expect((yield* claim("k", { scope: "bob" }))._tag).toBe("Claimed");
      }));

    // A database may compare text more loosely than `===` does.
    test("keeps keys apart that differ only in case or in trailing spaces", () =>
      Effect.gen(function* () {
        for (const key of ["k", "K", "k ", " k"]) {
          expect((yield* claim(key))._tag).toBe("Claimed");
        }
        for (const scope of ["scope ", "SCOPE", ""]) {
          expect((yield* claim("k", { scope }))._tag).toBe("Claimed");
        }
      }));

    test("takes a scope, a key and a fingerprint with any characters", () =>
      Effect.gen(function* () {
        // A key is printable ASCII. A scope and a fingerprint are any text.
        const keys = [
          "'; DROP TABLE keys; --",
          "' OR '1'='1",
          '"quoted"',
          "100%_\\",
          "k".repeat(255),
        ];
        const texts = [...keys, "line\nbreak\ttab", "zażółć gęślą jaźń ✓ 🔑"];
        for (const key of keys) {
          expect((yield* claim(key))._tag).toBe("Claimed");
          expect((yield* claim(key))._tag).toBe("InProgress");
        }
        for (const text of texts) {
          expect(
            (yield* claim("k", { scope: text, fingerprint: text }))._tag,
          ).toBe("Claimed");
          expect(yield* claim("k", { scope: text })).toEqual({
            _tag: "InProgress",
            fingerprint: IdempotencyStore.Fingerprint.make(text),
          });
        }
        // None of them reached a key next to it.
        expect((yield* claim("k"))._tag).toBe("Claimed");
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

    test("reports the fingerprint of the claim that took an expired key", () =>
      Effect.gen(function* () {
        yield* claimed("k");
        yield* TestClock.adjust(lockExpiry);
        expect((yield* claim("k", { fingerprint: "second" }))._tag).toBe(
          "Claimed",
        );
        expect(yield* claim("k")).toEqual({
          _tag: "InProgress",
          fingerprint: IdempotencyStore.Fingerprint.make("second"),
        });
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

    test("keeps a response for good when the retention is infinite", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        yield* store.complete(yield* claimed("k"), response, Duration.infinity);
        // Not a longer time: a database client has timers of its own, and
        // the test clock runs each of them for every interval it skips.
        yield* TestClock.adjust(Duration.days(30));
        expect((yield* claim("k"))._tag).toBe("Completed");
      }));

    test("takes a lock expiry and a retention that are not whole milliseconds", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const result = yield* store.claim({
          scope: "scope",
          key: IdempotencyKey.IdempotencyKey.make("k"),
          fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
          lockExpiry: Duration.micros(1_500_500n),
        });
        if (result._tag !== "Claimed")
          return expect<string>(result._tag).toBe("Claimed");
        yield* store.complete(result.claim, response, Duration.micros(2_500n));

        yield* TestClock.adjust(Duration.millis(2));
        expect((yield* claim("k"))._tag).toBe("Completed");
        yield* TestClock.adjust(Duration.millis(1));
        expect((yield* claim("k"))._tag).toBe("Claimed");
      }));

    test("gives back every part of a response as it was stored", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const whole: IdempotencyStore.StoredResponse = {
          status: 207,
          statusText: "Multi-Status ✓",
          headers: {
            "content-type": "application/octet-stream",
            "x-quote": `"it's"; \\ %s`,
            "x-unicode": "zażółć 🔑",
            "x-empty": "",
          },
          cookies: [
            "a=1; Path=/; HttpOnly",
            "b=two%20words; Max-Age=60; SameSite=Lax",
          ],
          body: everyByte,
        };
        yield* store.complete(yield* claimed("whole"), whole, retention);
        expect(yield* claim("whole")).toMatchObject({
          _tag: "Completed",
          response: whole,
        });
      }));

    test("keeps a response without a body apart from one with an empty body", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const none: IdempotencyStore.StoredResponse = {
          status: 204,
          headers: {},
          cookies: [],
        };
        const empty = { ...none, status: 200, body: new Uint8Array() };
        yield* store.complete(yield* claimed("none"), none, retention);
        yield* store.complete(yield* claimed("empty"), empty, retention);

        const stored = (key: string) =>
          Effect.map(claim(key), (result) =>
            result._tag === "Completed" ? result.response : result._tag,
          );
        expect(yield* stored("none")).toEqual(none);
        expect(yield* stored("none")).not.toHaveProperty("body");
        expect(yield* stored("empty")).toEqual(empty);
      }));

    test("keeps a response of a megabyte", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const body = Uint8Array.from(
          { length: 1024 * 1024 },
          (_, index) => (index * 31) & 0xff,
        );
        yield* store.complete(
          yield* claimed("k"),
          { ...response, body },
          retention,
        );

        const result = yield* claim("k");
        if (result._tag !== "Completed")
          return expect<string>(result._tag).toBe("Completed");
        // Compared as one value: a diff of a million bytes helps nobody.
        expect(Bun.deepEquals(result.response.body, body)).toBe(true);
      }));

    test("replaces the response when a claim completes again", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* store.complete(first, response, retention);
        const changed = { ...response, headers: { "x-changed": "yes" } };
        yield* store.complete(first, changed, retention);

        expect(yield* claim("k")).toMatchObject({
          _tag: "Completed",
          response: changed,
        });
      }));

    // Without this rule the answer would depend on whether the store had
    // got round to deleting the expired response, which nobody can know.
    test("does not store a response again once its retention is over", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* store.complete(first, response, retention);

        yield* TestClock.adjust(
          Duration.subtract(retention, Duration.millis(1)),
        );
        yield* store.complete(first, { ...response, status: 202 }, retention);
        yield* TestClock.adjust(Duration.millis(1));
        // The second completion counted its retention from when it was made.
        expect(yield* claim("k")).toMatchObject({
          _tag: "Completed",
          response: { status: 202 },
        });

        // To the millisecond in which that retention ends.
        yield* TestClock.adjust(
          Duration.subtract(retention, Duration.millis(1)),
        );
        yield* store.complete(first, response, retention);
        expect((yield* claim("k"))._tag).toBe("Claimed");
      }));

    test("does not let a completed claim replace the response of its successor", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* store.complete(first, response, retention);
        yield* TestClock.adjust(retention);
        const second = yield* claimed("k");

        yield* store.complete(first, response, retention);
        expect((yield* claim("k"))._tag).toBe("InProgress");

        const other = { ...response, status: 202 };
        yield* store.complete(second, other, retention);
        yield* store.complete(first, response, retention);
        expect(yield* claim("k")).toMatchObject({
          _tag: "Completed",
          response: other,
        });
      }));

    test("does not release a completed key", () =>
      Effect.gen(function* () {
        const store = yield* IdempotencyStore.IdempotencyStore;
        const first = yield* claimed("k");
        yield* store.complete(first, response, retention);
        yield* store.release(first);
        expect((yield* claim("k"))._tag).toBe("Completed");
      }));

    test("answers as the memory store does, whatever the order of events", () =>
      Effect.flatMap(IdempotencyStore.IdempotencyStore, (store) =>
        agreesWithMemoryStore(store, { runs: options?.modelRuns ?? 100 }),
      ));
  });
};
