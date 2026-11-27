import { Effect, flow } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { IdempotencyKey } from "effect-idempotency";
import { Api } from "./Api.ts";

const pay = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api, {
    transformClient: HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl("http://localhost:3000"),
        HttpClientRequest.bearerToken("dev-token"),
      ),
    ),
  });

  // One key per operation. Send the same key again to retry it.
  const key = IdempotencyKey.IdempotencyKey.make(crypto.randomUUID());
  const request = {
    headers: { "idempotency-key": key },
    payload: { amount: 5 },
  };

  const first = yield* client.payments.create(request);
  const retry = yield* client.payments.create(request);
  // `retry` is the stored response: the same payment, charged once.
  return { first, retry };
}).pipe(Effect.provide(FetchHttpClient.layer));

Effect.runPromise(pay).then(console.log, console.error);
