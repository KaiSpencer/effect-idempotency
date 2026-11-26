/**
 * Serves the fixture API with `Bun.serve`, through
 * `HttpRouter.toWebHandler`, on a store of the caller's choosing.
 */
import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { IdempotencyStore } from "../../src/index.ts";
import * as Payments from "../fixtures/Payments.ts";

/**
 * Serves the API on a free port and provides a client pointed at it. Each
 * build is a server of its own, with a ledger and a build of `store` of its
 * own, and stops when its scope closes.
 */
export const serve = (
  store: Layer.Layer<IdempotencyStore.IdempotencyStore>,
): Layer.Layer<HttpClient.HttpClient> => {
  const Routes = HttpApiBuilder.layer(Payments.Api).pipe(
    Layer.provide(Payments.layer),
    Layer.provide(store),
    Layer.provide(HttpServer.layerServices),
  );
  return Layer.effect(
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
};
