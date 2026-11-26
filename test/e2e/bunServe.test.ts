import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { IdempotencyStore } from "../../src/index.ts";
import * as Payments from "../fixtures/Payments.ts";
import { idempotencyScenarios } from "./scenarios.ts";

const Routes = HttpApiBuilder.layer(Payments.Api).pipe(
  Layer.provide(Payments.layer),
  Layer.provide(IdempotencyStore.layerMemory),
  Layer.provide(HttpServer.layerServices),
);

/** Serves the API on a free port and provides a client pointed at it. */
const Server = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const { server } = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const web = HttpRouter.toWebHandler(Routes, { disableLogger: true });
        return {
          web,
          server: Bun.serve({
            port: 0,
            fetch: (request) => web.handler(request),
          }),
        };
      }),
      ({ server, web }) =>
        Effect.promise(async () => {
          await server.stop(true);
          await web.dispose();
        }),
    );
    const client = yield* HttpClient.HttpClient;
    return HttpClient.mapRequest(
      client,
      HttpClientRequest.prependUrl(server.url.origin),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

idempotencyScenarios("Bun.serve with HttpRouter.toWebHandler", Server);
