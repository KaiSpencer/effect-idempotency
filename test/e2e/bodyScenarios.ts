/**
 * What a client sees for the bodies that are not bytes in memory: a streamed
 * response, a payload that is a stream or multipart, and an upload whose body
 * the fingerprint leaves out. `scenarios.ts` runs these for every way of
 * serving the fixture API, under its own `test`.
 */
import { Effect, Fiber, type Scope } from "effect";
import {
  type HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  HttpClient as Client,
} from "effect/http";
import { describe, expect } from "../support/EffectTest.ts";

type Test = <A, E>(
  label: string,
  self: () => Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>,
) => void;

type Response = Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError,
  HttpClient.HttpClient
>;

const asAlice = HttpClientRequest.setHeaders({
  "x-user": "alice",
  "idempotency-key": "k1",
});

/** A receipt streamed as `receipt for <payment id>`, charged part way. */
const receipt = (amount: number, headers?: Record<string, string>): Response =>
  HttpClientRequest.post("/payments/receipt").pipe(
    asAlice,
    HttpClientRequest.setHeaders(headers ?? {}),
    HttpClientRequest.bodyText(JSON.stringify({ amount }), "application/json"),
    Client.execute,
  );

/** A receipt read to the end. */
const receiptText = (amount: number) =>
  Effect.flatMap(receipt(amount), (response) => response.text);

/** Sends `request` until its first request has ended. */
const untilSettled = Effect.fnUntraced(function* (request: Response) {
  let response = yield* request;
  while (response.status === 409) {
    yield* Effect.sleep("1 millis");
    response = yield* request;
  }
  return response;
});

const batch = (body: string): Response =>
  HttpClientRequest.post("/payments/batch").pipe(
    asAlice,
    HttpClientRequest.bodyText(body, "application/x-ndjson"),
    Client.execute,
  );

/**
 * A multipart form with a fixed boundary, so that a retry sends the same
 * bytes, as a client that keeps the encoded body does. It carries a file, so
 * the buffered endpoint saves one to disk.
 */
const form = (amount: string) =>
  [
    "--boundary",
    'Content-Disposition: form-data; name="amount"',
    "",
    amount,
    "--boundary",
    'Content-Disposition: form-data; name="receipt"; filename="receipt.txt"',
    "Content-Type: text/plain",
    "",
    "paid in full",
    "--boundary--",
    "",
  ].join("\r\n");

const invoice = (path: string, body: string): Response =>
  HttpClientRequest.post(path).pipe(
    asAlice,
    HttpClientRequest.bodyText(body, "multipart/form-data; boundary=boundary"),
    Client.execute,
  );

const upload = (body: string, headers?: Record<string, string>): Response =>
  HttpClientRequest.post("/payments/upload").pipe(
    asAlice,
    HttpClientRequest.setHeaders(headers ?? {}),
    HttpClientRequest.bodyText(body, "application/octet-stream"),
    Client.execute,
  );

export const bodyScenarios = (
  test: Test,
  ledger: {
    readonly charges: Effect.Effect<number, unknown, HttpClient.HttpClient>;
    readonly chargesReach: (
      count: number,
    ) => Effect.Effect<void, unknown, HttpClient.HttpClient>;
    readonly hold: Effect.Effect<void, unknown, HttpClient.HttpClient>;
    readonly resume: Effect.Effect<void, unknown, HttpClient.HttpClient>;
  },
): void => {
  const { charges, chargesReach, hold, resume } = ledger;

  describe("a streamed response", () => {
    test("is stored once it has ended, and replayed", () =>
      Effect.gen(function* () {
        const first = yield* receipt(5);
        expect(first.headers["content-type"]).toBe("text/plain");
        expect(yield* first.text).toBe("receipt for pay_1");

        const retry = yield* untilSettled(receipt(5));
        expect(retry.status).toBe(200);
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(retry.headers["content-type"]).toBe("text/plain");
        expect(yield* retry.text).toBe("receipt for pay_1");
        expect(yield* charges).toBe(1);
      }));

    // The stream is short, so it can be read to the end before the server
    // sends the response, and so before the handler's change is made. The
    // handler runs in the request's own scope, which closes only once the
    // response has been sent.
    test("keeps what the handler opened until its change to the response is made, and replays the change", () =>
      Effect.gen(function* () {
        const inRequestScope = () => receipt(5, { "x-request-scope": "yes" });
        const first = yield* inRequestScope();
        expect(first.headers["x-printer"]).toBe("open");
        yield* first.text;

        let retry = yield* untilSettled(inRequestScope());
        // The change is stored by a second write, which can land just after
        // the stream's.
        while (retry.headers["x-printer"] === undefined) {
          yield* Effect.sleep("1 millis");
          retry = yield* untilSettled(inRequestScope());
        }
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(retry.headers["x-printer"]).toBe("open");
        expect(yield* charges).toBe(1);
      }));

    test("answers 409 while it is still being sent", () =>
      Effect.gen(function* () {
        yield* hold;
        const first = yield* Effect.forkChild(receiptText(5));
        // The first chunk is sent and the charge has started.
        yield* chargesReach(1);

        expect((yield* receipt(5)).status).toBe(409);

        yield* resume;
        expect(yield* Fiber.join(first)).toBe("receipt for pay_1");
        const retry = yield* untilSettled(receipt(5));
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* charges).toBe(1);
      }));

    test("is read to the end when its client leaves, and replayed to the retry", () =>
      Effect.gen(function* () {
        yield* hold;
        const first = yield* Effect.forkChild(receiptText(5));
        yield* chargesReach(1);
        // Interrupting the read aborts it, which closes the connection.
        yield* Fiber.interrupt(first);
        yield* Effect.sleep("20 millis");
        expect((yield* receipt(5)).status).toBe(409);

        yield* resume;
        const retry = yield* untilSettled(receipt(5));
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* retry.text).toBe("receipt for pay_1");
        expect(yield* charges).toBe(1);
      }));

    test("that fails part way is not stored, so a retry runs the handler again", () =>
      Effect.gen(function* () {
        // The server cuts the connection: before the status if it has not
        // sent it yet, or part way through the body.
        expect((yield* Effect.exit(receiptText(-1)))._tag).toBe("Failure");

        // The key is released once the stream has failed, which the client
        // can see only by the 409s ending.
        let retry = yield* Effect.exit(receipt(-1));
        while (retry._tag === "Success" && retry.value.status === 409) {
          yield* Effect.sleep("1 millis");
          retry = yield* Effect.exit(receipt(-1));
        }
        expect(
          retry._tag === "Success" &&
            retry.value.headers["idempotent-replayed"],
        ).not.toBe("true");
        expect(yield* charges).toBe(2);
      }));
  });

  describe("a streamed payload", () => {
    test("reaches the handler, and is part of the fingerprint", () =>
      Effect.gen(function* () {
        const lines = '{"amount":2}\n{"amount":3}\n';
        const first = yield* batch(lines);
        expect(yield* first.json).toEqual({ id: "pay_1", amount: 5 });

        const retry = yield* batch(lines);
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* retry.json).toEqual({ id: "pay_1", amount: 5 });

        expect((yield* batch('{"amount":2}\n')).status).toBe(422);
        expect(yield* charges).toBe(1);
      }));
  });

  describe("a multipart payload", () => {
    test("read whole reaches the handler, and is part of the fingerprint", () =>
      Effect.gen(function* () {
        const first = yield* invoice("/payments/invoice", form("5"));
        expect(yield* first.json).toEqual({ id: "pay_1", amount: 5 });

        const retry = yield* invoice("/payments/invoice", form("5"));
        expect(retry.headers["idempotent-replayed"]).toBe("true");

        expect((yield* invoice("/payments/invoice", form("6"))).status).toBe(
          422,
        );
        expect(yield* charges).toBe(1);
      }));

    test("read part by part reaches the handler, and is part of the fingerprint", () =>
      Effect.gen(function* () {
        const first = yield* invoice("/payments/invoice-parts", form("5"));
        expect(yield* first.json).toEqual({ id: "pay_1", amount: 5 });

        const retry = yield* invoice("/payments/invoice-parts", form("5"));
        expect(retry.headers["idempotent-replayed"]).toBe("true");

        expect(
          (yield* invoice("/payments/invoice-parts", form("6"))).status,
        ).toBe(422);
        expect(yield* charges).toBe(1);
      }));

    // Documented in Limits: a client that encodes the form again draws a new
    // boundary, so its retry is not the same bytes.
    test("built again with a new boundary is a different request", () =>
      Effect.gen(function* () {
        const send = () => {
          const data = new FormData();
          data.append("amount", "5");
          return HttpClientRequest.post("/payments/invoice").pipe(
            asAlice,
            HttpClientRequest.bodyFormData(data),
            Client.execute,
          );
        };
        expect((yield* send()).status).toBe(200);
        expect((yield* send()).status).toBe(422);
      }));
  });

  describe("an upload the fingerprint leaves out", () => {
    test("reaches the handler, and a retry with another body is replayed", () =>
      Effect.gen(function* () {
        const first = yield* upload("abcd");
        expect(yield* first.json).toEqual({ id: "pay_1", amount: 4 });

        const retry = yield* upload("abcdef");
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* retry.json).toEqual({ id: "pay_1", amount: 4 });
        expect(yield* charges).toBe(1);
      }));

    test("is told apart from another by its Content-Digest", () =>
      Effect.gen(function* () {
        yield* upload("abcd", { "content-digest": "sha-256=:one:" });
        const other = yield* upload("abcd", {
          "content-digest": "sha-256=:two:",
        });
        expect(other.status).toBe(422);

        const retry = yield* upload("abcd", {
          "content-digest": "sha-256=:one:",
        });
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* charges).toBe(1);
      }));
  });
};
