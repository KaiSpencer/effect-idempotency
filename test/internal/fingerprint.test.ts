import { Effect } from "effect";
import { Digest } from "effect/crypto";
import { HttpServerRequest } from "effect/http";
import * as Fingerprint from "../../src/internal/fingerprint.ts";
import { describe, expect, it } from "../support/EffectTest.ts";

const request = (options?: { method?: string; url?: string; body?: string }) =>
  HttpServerRequest.fromWeb(
    new Request(options?.url ?? "http://localhost/payments?currency=eur", {
      method: options?.method ?? "POST",
      body: options?.body ?? '{"amount":5}',
    }),
  );

const fingerprint = (options?: Parameters<typeof request>[0]) =>
  Effect.provide(Fingerprint.make(request(options)), Digest.layerWebCrypto);

describe("Fingerprint", () => {
  it.effect("is the same for the same request", () =>
    Effect.gen(function* () {
      expect(yield* fingerprint()).toBe(yield* fingerprint());
    }),
  );

  it.effect.each([
    ["method", { method: "PUT" }],
    ["path", { url: "http://localhost/refunds?currency=eur" }],
    ["query", { url: "http://localhost/payments?currency=usd" }],
    ["body", { body: '{"amount":6}' }],
    ["body's whitespace", { body: '{ "amount": 5 }' }],
  ] as const)("changes with the %s", ([, change]) =>
    Effect.gen(function* () {
      expect(yield* fingerprint(change)).not.toBe(yield* fingerprint());
    }),
  );

  it.effect.each([
    ["scheme", "https://localhost/payments?currency=eur"],
    ["host", "http://api.example/payments?currency=eur"],
    ["port", "http://localhost:8080/payments?currency=eur"],
  ] as const)("does not change with the scheme, host or port", ([, url]) =>
    Effect.gen(function* () {
      expect(yield* fingerprint({ url })).toBe(yield* fingerprint());
    }),
  );

  it.effect(
    "keeps the path the client asked for when a router rewrites the url",
    () =>
      Effect.gen(function* () {
        const mounted = request().modify({ url: "/?currency=eur" });
        expect(
          yield* Effect.provide(
            Fingerprint.make(mounted),
            Digest.layerWebCrypto,
          ),
        ).toBe(yield* fingerprint());
      }),
  );

  it.effect("leaves the body for the handler to read", () =>
    Effect.gen(function* () {
      const incoming = request();
      yield* Effect.provide(Fingerprint.make(incoming), Digest.layerWebCrypto);
      expect(yield* incoming.text).toBe('{"amount":5}');
    }),
  );
});
