import { Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { IdempotencyKey, IdempotencyStore } from "../src/index.ts";
import * as memoryStore from "../src/internal/memoryStore.ts";
import { describe, expect, it, test } from "./support/EffectTest.ts";
import { storeContract } from "./support/storeContract.ts";

storeContract("layerMemory", IdempotencyStore.layerMemory);

describe("layerMemory", () => {
  const setup = Effect.map(memoryStore.makeWithSize, ({ size, store }) => ({
    size,
    store,
    claim: (key: string) =>
      store.claim({
        scope: "scope",
        key: IdempotencyKey.IdempotencyKey.make(key),
        fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
        lockExpiry: Duration.seconds(1),
      }),
  }));
  const response: IdempotencyStore.StoredResponse = {
    status: 200,
    headers: {},
    cookies: [],
  };

  it.effect(
    "removes expired responses whose keys are never claimed again",
    () =>
      Effect.gen(function* () {
        const { claim, size, store } = yield* setup;
        for (const key of ["a", "b", "c"]) {
          const result = yield* claim(key);
          if (result._tag === "Claimed") {
            yield* store.complete(result.claim, response, Duration.seconds(1));
          }
        }
        expect(yield* size).toBe(3);

        yield* TestClock.adjust(memoryStore.sweepInterval);
        yield* claim("d");
        expect(yield* size).toBe(1);
      }),
  );

  it.effect("keeps an expired claim, whose request may still complete it", () =>
    Effect.gen(function* () {
      const { claim, size } = yield* setup;
      yield* claim("a");

      yield* TestClock.adjust(memoryStore.sweepInterval);
      yield* claim("b");
      expect(yield* size).toBe(2);
    }),
  );
});

describe("StoredResponse", () => {
  const Json = Schema.toCodecJson(IdempotencyStore.StoredResponse);

  test("survives a round trip through JSON text", () => {
    const response: IdempotencyStore.StoredResponse = {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json" },
      cookies: ["session=abc; Path=/"],
      body: new Uint8Array([0, 123, 125, 255]),
    };
    const text = JSON.stringify(Schema.encodeSync(Json)(response));

    expect(Schema.decodeUnknownSync(Json)(JSON.parse(text))).toEqual(response);
  });

  test("survives the round trip without a body or a status text", () => {
    const response: IdempotencyStore.StoredResponse = {
      status: 204,
      headers: {},
      cookies: [],
    };
    const text = JSON.stringify(Schema.encodeSync(Json)(response));

    expect(Schema.decodeUnknownSync(Json)(JSON.parse(text))).toEqual(response);
  });

  test("refuses a stored value that is not a response", () => {
    expect(() => Schema.decodeUnknownSync(Json)({ status: "200" })).toThrow();
  });
});
