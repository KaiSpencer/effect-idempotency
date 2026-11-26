import { Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { IdempotencyKey, IdempotencyStore } from "../src/index.ts";
import * as memoryStore from "../src/internal/memoryStore.ts";
import { describe, expect, it, test } from "./support/EffectTest.ts";
import { storeContract } from "./support/storeContract.ts";

storeContract("layerMemory", IdempotencyStore.layerMemory);

describe("layerMemory", () => {
  it.effect("removes expired entries whose keys are never claimed again", () =>
    Effect.gen(function* () {
      const { size, store } = yield* memoryStore.makeWithSize;
      const claim = (key: string) =>
        store.claim({
          scope: "scope",
          key: IdempotencyKey.IdempotencyKey.make(key),
          fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
          lockExpiry: Duration.seconds(1),
        });
      yield* Effect.forEach(["a", "b", "c"], claim);
      expect(yield* size).toBe(3);

      yield* TestClock.adjust(memoryStore.sweepInterval);
      yield* claim("d");
      expect(yield* size).toBe(1);
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
