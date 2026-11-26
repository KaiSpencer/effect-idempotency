/**
 * What a client sees over a real connection. The scenarios only speak HTTP,
 * so they run unchanged against any way of serving the fixture API: each
 * setup's test file passes `idempotencyScenarios` a layer that starts a
 * server and provides an `HttpClient` pointed at it. The layer is built again
 * for every test, so each one meets a fresh server.
 *
 * Payments are sent as raw requests, because the scenarios assert on status
 * codes, headers and bytes and send header values a typed client would not.
 * The control endpoints go through the typed client.
 */
import { Effect, Fiber, type Layer, type Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import * as Payments from "../fixtures/Payments.ts";
import { describe, expect, it } from "../support/EffectTest.ts";

const problemJson = "application/problem+json";
const problemType = (name: string) =>
  `https://github.com/KaiSpencer/effect-idempotency#${name}`;

/** Creates a payment as `alice` with the key `k1` unless told otherwise. */
export const create = (
  amount: number,
  options?: {
    key?: string | undefined;
    user?: string;
    body?: string;
    contentType?: string;
    host?: string;
  },
) => {
  const key = options !== undefined && "key" in options ? options.key : "k1";
  return HttpClientRequest.post("/payments").pipe(
    HttpClientRequest.setHeaders({
      "x-user": options?.user ?? "alice",
      ...(key === undefined ? {} : { "idempotency-key": key }),
      ...(options?.host === undefined ? {} : { host: options.host }),
    }),
    HttpClientRequest.bodyText(
      options?.body ?? JSON.stringify({ amount }),
      options?.contentType ?? "application/json",
    ),
    HttpClient.execute,
  );
};

const receipt = HttpClientRequest.post("/payments/receipt").pipe(
  HttpClientRequest.setHeaders({ "x-user": "alice", "idempotency-key": "k1" }),
  HttpClient.execute,
);

const checkout = HttpClientRequest.post("/payments/checkout").pipe(
  HttpClientRequest.setHeaders({ "x-user": "alice", "idempotency-key": "k1" }),
  HttpClient.execute,
);

/**
 * Retries the checkout until the first one, whose client has gone, has
 * ended, and returns the replay.
 *
 * Until then a retry is answered 409 and then, for the one round trip to the
 * store that adding the cookie takes, with the response as the handler
 * returned it. Nothing but the cookie tells the test that this is over: it
 * cannot see the first request end. A cookie that never comes fails the test
 * by its time limit.
 */
const checkoutOnceSettled = Effect.gen(function* () {
  let retry = yield* checkout;
  while (retry.status === 409 || retry.headers["set-cookie"] === undefined) {
    yield* Effect.sleep("1 millis");
    retry = yield* checkout;
  }
  return retry;
});

/** A checkout that a middleware fails after its handler has succeeded. */
const checkoutFailingAfter = HttpClientRequest.post("/payments/checkout").pipe(
  HttpClientRequest.setHeaders({
    "x-user": "alice",
    "idempotency-key": "k1",
    "x-fail-after-handler": "yes",
  }),
  HttpClient.execute,
);

const control = Effect.map(
  HttpApiClient.make(Payments.Api),
  (client) => client.control,
);
export const charges = Effect.flatMap(control, (ledger) => ledger.charges());
export const hold = Effect.flatMap(control, (ledger) => ledger.hold());
export const resume = Effect.flatMap(control, (ledger) => ledger.resume());

/** Waits until `count` charges have started. */
export const chargesReach = Effect.fnUntraced(function* (count: number) {
  while ((yield* charges) < count) yield* Effect.sleep("1 millis");
});

export const idempotencyScenarios = (
  name: string,
  server: Layer.Layer<HttpClient.HttpClient>,
): void => {
  // Real time: the server is on a socket, and the scenarios wait on it.
  const test = <A, E>(
    label: string,
    self: () => Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>,
  ): void => {
    it.live(label, () => Effect.provide(Effect.suspend(self), server));
  };

  describe(name, () => {
    test("runs the handler and answers with its response", () =>
      Effect.gen(function* () {
        const response = yield* create(5);

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("application/json");
        expect(response.headers["idempotent-replayed"]).toBeUndefined();
        expect(yield* response.json).toEqual({ id: "pay_1", amount: 5 });
      }));

    test("replays the same status, content type and bytes to a retry", () =>
      Effect.gen(function* () {
        const first = yield* create(5);
        const retry = yield* create(5);

        expect(retry.status).toBe(first.status);
        expect(retry.headers["content-type"]).toBe(
          first.headers["content-type"],
        );
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* retry.arrayBuffer).toEqual(yield* first.arrayBuffer);
        expect(yield* charges).toBe(1);
      }));

    test("reads a quoted and a bare key as the same key", () =>
      Effect.gen(function* () {
        yield* create(5, { key: '"k1"' });
        const retry = yield* create(5, { key: "k1" });

        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* charges).toBe(1);
      }));

    test("answers 400 without a key", () =>
      Effect.gen(function* () {
        const response = yield* create(5, { key: undefined });

        expect(response.status).toBe(400);
        expect(response.headers["content-type"]).toBe(problemJson);
        expect(yield* response.json).toEqual({
          type: problemType("idempotency-key-missing"),
          status: 400,
          title: "The Idempotency-Key header is missing.",
        });
        expect(yield* charges).toBe(0);
      }));

    test("answers 400 to a key that is not valid", () =>
      Effect.gen(function* () {
        const response = yield* create(5, { key: "k".repeat(256) });

        expect(response.status).toBe(400);
        expect(response.headers["content-type"]).toBe(problemJson);
        expect(yield* response.json).toMatchObject({
          type: problemType("idempotency-key-invalid"),
        });
        expect(yield* charges).toBe(0);
      }));

    test("answers 422 when the key was used with a different request", () =>
      Effect.gen(function* () {
        yield* create(5);
        const response = yield* create(6);

        expect(response.status).toBe(422);
        expect(response.headers["content-type"]).toBe(problemJson);
        expect(yield* response.json).toMatchObject({
          type: problemType("idempotency-key-mismatch"),
        });
        expect(yield* charges).toBe(1);
      }));

    test("compares the body byte for byte", () =>
      Effect.gen(function* () {
        yield* create(5, { body: '{"amount":5}' });
        const response = yield* create(5, { body: '{ "amount": 5 }' });

        expect(response.status).toBe(422);
      }));

    test("treats the same request through another host name as a retry", () =>
      Effect.gen(function* () {
        yield* create(5, { host: "a.example" });
        const retry = yield* create(5, { host: "b.example" });

        expect(retry.status).toBe(200);
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* charges).toBe(1);
      }));

    test("answers 409 while the first request is running, then replays it", () =>
      Effect.gen(function* () {
        yield* hold;
        const first = yield* Effect.forkChild(create(5));
        yield* chargesReach(1);

        const during = yield* create(5);
        expect(during.status).toBe(409);
        expect(during.headers["content-type"]).toBe(problemJson);
        expect(yield* during.json).toMatchObject({
          type: problemType("idempotency-key-in-progress"),
        });

        yield* resume;
        const payment = yield* (yield* Fiber.join(first)).json;
        const after = yield* create(5);
        expect(after.headers["idempotent-replayed"]).toBe("true");
        expect(yield* after.json).toEqual(payment);
        expect(yield* charges).toBe(1);
      }));

    test("finishes a request whose client disconnected, and replays it to the retry", () =>
      Effect.gen(function* () {
        yield* hold;
        const first = yield* Effect.forkChild(create(5));
        yield* chargesReach(1);
        // Interrupting the request aborts it, which closes the connection.
        yield* Fiber.interrupt(first);

        // The handler is still running: the disconnect did not release the key.
        yield* Effect.sleep("20 millis");
        expect((yield* create(5)).status).toBe(409);

        yield* resume;
        let retry = yield* create(5);
        while (retry.status === 409) {
          yield* Effect.sleep("1 millis");
          retry = yield* create(5);
        }
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* retry.json).toEqual({ id: "pay_1", amount: 5 });
        expect(yield* charges).toBe(1);
      }));

    test("runs the handler once for many concurrent requests with one key", () =>
      Effect.gen(function* () {
        const responses = yield* Effect.all(
          Array.from({ length: 20 }, () => create(5)),
          { concurrency: "unbounded" },
        );

        const replayed = responses.filter(
          (response) => response.headers["idempotent-replayed"] === "true",
        );
        const ran = responses.filter(
          (response) => response.status === 200 && !replayed.includes(response),
        );
        const refused = responses.filter((response) => response.status === 409);
        expect(ran).toHaveLength(1);
        expect(replayed.length + refused.length).toBe(19);
        expect(yield* charges).toBe(1);
      }));

    test("does not store a failure, so a retry runs the handler again", () =>
      Effect.gen(function* () {
        const first = yield* create(-1);
        const retry = yield* create(-1);

        expect(first.status).toBe(402);
        expect(retry.status).toBe(402);
        expect(retry.headers["idempotent-replayed"]).toBeUndefined();
        expect(yield* charges).toBe(2);
      }));

    test("does not store a 500, so a retry runs the handler again", () =>
      Effect.gen(function* () {
        expect((yield* create(0)).status).toBe(500);
        expect((yield* create(0)).status).toBe(500);
        expect(yield* charges).toBe(2);
      }));

    test("does not store a request the API refuses before the handler", () =>
      Effect.gen(function* () {
        const refused = yield* create(5, { contentType: "text/plain" });
        expect(refused.status).toBe(415);

        // The same key and bytes, corrected, are not answered with the 415.
        const corrected = yield* create(5);
        expect(corrected.status).toBe(200);
        expect(corrected.headers["idempotent-replayed"]).toBeUndefined();
        expect(yield* charges).toBe(1);
      }));

    test("does not store a request that fails validation", () =>
      Effect.gen(function* () {
        const first = yield* create(5, { body: '{"amount":"five"}' });
        const retry = yield* create(5, { body: '{"amount":"five"}' });

        expect(first.status).toBe(400);
        expect(retry.status).toBe(400);
        expect(retry.headers["idempotent-replayed"]).toBeUndefined();
        expect(yield* charges).toBe(0);
      }));

    test("answers 400 to two key headers", () =>
      Effect.gen(function* () {
        const response = yield* create(5, { key: "k1, k2" });

        expect(response.status).toBe(400);
        expect(yield* response.json).toMatchObject({
          type: problemType("idempotency-key-invalid"),
        });
        expect(yield* charges).toBe(0);
      }));

    test("keeps the same key of two users apart", () =>
      Effect.gen(function* () {
        expect(yield* (yield* create(5, { user: "alice" })).json).toMatchObject(
          { id: "pay_1" },
        );
        expect(yield* (yield* create(5, { user: "bob" })).json).toMatchObject({
          id: "pay_2",
        });
      }));

    test("replays a cookie the handler set through securitySetCookie", () =>
      Effect.gen(function* () {
        const first = yield* checkout;
        const retry = yield* checkout;

        expect(first.headers["set-cookie"]).toContain("last-payment=pay_1");
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(retry.headers["set-cookie"]).toBe(first.headers["set-cookie"]);
        expect(yield* charges).toBe(1);
      }));

    // The cookie is on the replay whether or not the server had seen the
    // client leave by the time the handler finished.
    test("replays that cookie to a retry when the first client left before the response", () =>
      Effect.gen(function* () {
        yield* hold;
        const first = yield* Effect.forkChild(checkout);
        yield* chargesReach(1);
        yield* Fiber.interrupt(first);
        yield* resume;

        const retry = yield* checkoutOnceSettled;
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(retry.headers["set-cookie"]).toContain("last-payment=pay_1");
        expect(yield* retry.json).toEqual({ id: "pay_1", amount: 1 });
        expect(yield* charges).toBe(1);
      }));

    // The same, with the server certain to have seen the client leave.
    test("replays that cookie when the handler finished long after the client left", () =>
      Effect.gen(function* () {
        yield* hold;
        const first = yield* Effect.forkChild(checkout);
        yield* chargesReach(1);
        yield* Fiber.interrupt(first);
        yield* Effect.sleep("50 millis");
        yield* resume;

        const retry = yield* checkoutOnceSettled;
        expect(retry.headers["set-cookie"]).toContain("last-payment=pay_1");
        expect(yield* charges).toBe(1);
      }));

    test("sends the error of a request that failed after its handler, and replays the handler's response", () =>
      Effect.gen(function* () {
        const failed = yield* checkoutFailingAfter;
        expect(failed.status).toBe(401);
        expect(failed.headers["set-cookie"]).toBeUndefined();

        const retry = yield* checkout;
        expect(retry.status).toBe(200);
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(retry.headers["set-cookie"]).toContain("last-payment=pay_1");
        expect(yield* charges).toBe(1);
      }));

    test("sends a streamed response without storing it", () =>
      Effect.gen(function* () {
        expect(yield* (yield* receipt).text).toBe("receipt for pay_1");
        const retry = yield* receipt;
        expect(retry.headers["idempotent-replayed"]).toBeUndefined();
        expect(yield* retry.text).toBe("receipt for pay_2");
      }));
  });
};
