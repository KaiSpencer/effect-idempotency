import { Effect } from "effect";
import { Digest } from "effect/crypto";
import { HttpServerRequest } from "effect/http";
import * as Fingerprint from "../../src/internal/fingerprint.ts";
import { describe, expect, it } from "../support/EffectTest.ts";

const request = (options?: {
  method?: string;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}) =>
  HttpServerRequest.fromWeb(
    new Request(options?.url ?? "http://localhost/payments?currency=eur", {
      method: options?.method ?? "POST",
      body: options?.body ?? '{"amount":5}',
      headers: options?.headers ?? {},
    }),
  );

/** The fingerprint of a request, with its body. */
const fingerprint = (options?: Parameters<typeof request>[0]) => {
  const incoming = request(options);
  return Effect.flatMap(Effect.orDie(incoming.arrayBuffer), (body) =>
    Effect.provide(Fingerprint.make(incoming, body), Digest.layerWebCrypto),
  );
};

/** The fingerprint of a request, without its body. */
const withoutBody = (options?: Parameters<typeof request>[0]) =>
  Effect.provide(
    Fingerprint.make(request(options), undefined),
    Digest.layerWebCrypto,
  );

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
        const body = yield* Effect.orDie(mounted.arrayBuffer);
        expect(
          yield* Effect.provide(
            Fingerprint.make(mounted, body),
            Digest.layerWebCrypto,
          ),
        ).toBe(yield* fingerprint());
      }),
  );
});

describe("Fingerprint without the body", () => {
  it.effect("does not change with the body", () =>
    Effect.gen(function* () {
      expect(yield* withoutBody({ body: '{"amount":6}' })).toBe(
        yield* withoutBody(),
      );
    }),
  );

  it.effect("leaves the body unread", () =>
    Effect.gen(function* () {
      const incoming = request();
      yield* Effect.provide(
        Fingerprint.make(incoming, undefined),
        Digest.layerWebCrypto,
      );
      expect(yield* Effect.orDie(incoming.text)).toBe('{"amount":5}');
    }),
  );

  it.effect.each([
    ["method", { method: "PUT" }],
    ["path", { url: "http://localhost/refunds?currency=eur" }],
    ["query", { url: "http://localhost/payments?currency=usd" }],
    ["Content-Digest", { headers: { "content-digest": "sha-256=:a:" } }],
    ["Repr-Digest", { headers: { "repr-digest": "sha-256=:a:" } }],
  ] as const)("changes with the %s", ([, change]) =>
    Effect.gen(function* () {
      expect(yield* withoutBody(change)).not.toBe(yield* withoutBody());
    }),
  );

  it.effect(
    "does not change with the content type, so a new multipart boundary is the same request",
    () =>
      Effect.gen(function* () {
        expect(
          yield* withoutBody({
            headers: { "content-type": "multipart/form-data; boundary=a" },
          }),
        ).toBe(
          yield* withoutBody({
            headers: { "content-type": "multipart/form-data; boundary=b" },
          }),
        );
      }),
  );

  it.effect("tells one digest header from the other", () =>
    Effect.gen(function* () {
      expect(
        yield* withoutBody({ headers: { "content-digest": "sha-256=:a:" } }),
      ).not.toBe(
        yield* withoutBody({ headers: { "repr-digest": "sha-256=:a:" } }),
      );
    }),
  );

  it.effect("never equals the fingerprint of a body", () =>
    Effect.gen(function* () {
      expect(yield* withoutBody()).not.toBe(yield* fingerprint());
    }),
  );
});
