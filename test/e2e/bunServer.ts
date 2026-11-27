/**
 * Serves the fixture API with `Bun.serve`, through
 * `HttpRouter.toWebHandler`, on a store of the caller's choosing.
 */
import { BunFileSystem } from "@effect/platform-bun";
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
 * own, and stops when its scope closes. `options` are the middleware's.
 *
 * The file system is a real one, where a multipart upload saves its files.
 */
export const serve = (
  store: Layer.Layer<IdempotencyStore.IdempotencyStore>,
  options?: Parameters<typeof Payments.layerWith>[0],
): Layer.Layer<HttpClient.HttpClient> => {
  const Routes = HttpApiBuilder.layer(Payments.Api).pipe(
    Layer.provide(Payments.layerWith(options)),
    Layer.provide(store),
    Layer.provide(BunFileSystem.layer),
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
              // In development mode Bun prints the error a streamed response
              // body fails with, which the scenarios cause on purpose, and on
              // GitHub Actions it reports each one as an annotation on the
              // fixture. The test still sees the failure as a cut connection.
              development: false,
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
