/**
 * The server middleware.
 *
 * Declare a middleware class with {@link Service}, attach it to the endpoints
 * that need it, and provide it with {@link layer}:
 *
 * ```ts
 * class PaymentIdempotency extends Idempotency.Service<
 *   PaymentIdempotency,
 *   { requires: CurrentUser }
 * >()("app/PaymentIdempotency") {}
 *
 * const create = HttpApiEndpoint.post("create", "/payments", { ... })
 *   .middleware(PaymentIdempotency)
 *
 * const PaymentIdempotencyLive = Idempotency.layer(PaymentIdempotency, {
 *   scope: Effect.map(CurrentUser, (user) => user.id),
 * }).pipe(Layer.provide(IdempotencyStore.layerMemory))
 * ```
 *
 * @module
 */
import { type Context, Duration, Effect, Exit, Layer } from "effect";
import { Digest } from "effect/crypto";
import {
  type HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import {
  IdempotencyKeyInProgress,
  IdempotencyKeyInvalid,
  IdempotencyKeyMismatch,
  IdempotencyKeyMissing,
} from "./IdempotencyError.ts";
import * as IdempotencyKey from "./IdempotencyKey.ts";
import { IdempotencyStore } from "./IdempotencyStore.ts";
import * as Fingerprint from "./internal/fingerprint.ts";
import * as StoredResponse from "./internal/storedResponse.ts";

/** The errors every idempotency middleware declares. */
export const errors = [
  IdempotencyKeyMissing,
  IdempotencyKeyInvalid,
  IdempotencyKeyMismatch,
  IdempotencyKeyInProgress,
] as const;

/** The type of {@link errors}. */
export type Errors = typeof errors;

/** The header a replayed response carries, with the value `true`. */
export const replayedHeader = "idempotent-replayed";

/**
 * Declares an idempotency middleware: an `HttpApiMiddleware.Service` class
 * with the idempotency errors already declared.
 *
 * The class is part of the API definition, so it can be shared with a client.
 * Name the services its scope reads in `requires`; they must be provided by
 * a middleware added to the endpoint after this one, which runs outside it.
 *
 * ```ts
 * class PaymentIdempotency extends Idempotency.Service<
 *   PaymentIdempotency,
 *   { requires: CurrentUser }
 * >()("app/PaymentIdempotency") {}
 * ```
 */
export const Service =
  <Self, Config extends { requires?: unknown } = { requires: never }>() =>
  <const Id extends string>(id: Id) =>
    HttpApiMiddleware.Service<Self, Config>()(id, { error: errors });

/** The options of {@link layer}. */
export interface Options<Requires> {
  /**
   * Who a key belongs to, read once per request. A key is unique within its
   * scope, so two callers that send the same key do not see each other's
   * responses. Return the caller's id on an API with accounts.
   *
   * With a constant scope, every caller shares one set of keys: whoever sends
   * a key and request that were used before gets the stored response, cookies
   * included. Only use one on an API where that is acceptable.
   */
  readonly scope: Effect.Effect<string, never, Requires | HttpRouter.Provided>;
  /** How long a stored response is replayed. Defaults to 24 hours. */
  readonly retention?: Duration.Input | undefined;
  /**
   * How long a request may hold a key before another request may take it.
   * It matters when a process dies mid-request. Make it longer than the
   * slowest handler: a retry that arrives after it runs the handler again,
   * alongside the first request. Defaults to 5 minutes.
   */
  readonly lockExpiry?: Duration.Input | undefined;
}

/**
 * Provides an idempotency middleware declared with {@link Service}.
 *
 * For each request the middleware reads the key and claims it in the
 * `IdempotencyStore`:
 *
 * - No `Idempotency-Key` header fails with `IdempotencyKeyMissing`, and one
 *   that is not a valid key with `IdempotencyKeyInvalid`.
 * - A new key runs the handler. If it succeeds with a status below 400, the
 *   response is stored and sent. If it fails, dies, or answers 400 or above,
 *   the key is released and the next request with it runs the handler again.
 * - A key used before with a different request fails with
 *   `IdempotencyKeyMismatch`.
 * - A key whose first request is still running fails with
 *   `IdempotencyKeyInProgress`.
 * - A key whose first request succeeded gets the stored response, with the
 *   `Idempotent-Replayed: true` header added.
 *
 * Once a request has claimed its key the middleware does not let it be
 * interrupted, so a client that timed out and disconnected finds the response
 * stored when it retries. A handler that can hang needs its own timeout.
 *
 * A response whose body is not bytes in memory, such as a stream or a file,
 * is sent but not stored.
 *
 * If the store fails to claim the key, the request dies and the handler does
 * not run. If it fails to store a response, the response is still sent and
 * the key stays claimed until `lockExpiry`.
 */
export const layer = <Id, Requires>(
  service: Context.Service<
    Id,
    HttpApiMiddleware.HttpApiMiddleware<never, Errors, Requires>
  >,
  options: Options<Requires>,
): Layer.Layer<Id, never, IdempotencyStore> =>
  Layer.effect(
    service,
    Effect.gen(function* () {
      const store = yield* IdempotencyStore;
      const digest = yield* Digest.Digest;
      const retention = Duration.fromInputUnsafe(
        options.retention ?? "24 hours",
      );
      const lockExpiry = Duration.fromInputUnsafe(
        options.lockExpiry ?? "5 minutes",
      );

      return service.of(
        Effect.fnUntraced(function* (httpEffect) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const header = request.headers[IdempotencyKey.headerName];
          if (header === undefined) return yield* new IdempotencyKeyMissing();
          const key = IdempotencyKey.parse(header);
          if (key === undefined) return yield* new IdempotencyKeyInvalid();

          const scope = yield* options.scope;
          const fingerprint = yield* Effect.provideService(
            Fingerprint.make(request),
            Digest.Digest,
            digest,
          );

          // From the claim on, the request cannot be interrupted. A client
          // that gives up and disconnects would otherwise stop the handler
          // part way, and its retry would run the side effect a second time.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const result = yield* Effect.orDie(
                store.claim({ scope, key, fingerprint, lockExpiry }),
              );
              if (result._tag !== "Claimed") {
                if (result.fingerprint !== fingerprint)
                  return yield* new IdempotencyKeyMismatch();
                if (result._tag === "InProgress")
                  return yield* new IdempotencyKeyInProgress();
                return HttpServerResponse.setHeader(
                  StoredResponse.toResponse(result.response),
                  replayedHeader,
                  "true",
                );
              }

              const release = Effect.catchCause(
                store.release(result.claim),
                (cause) =>
                  Effect.logError(
                    "effect-idempotency: could not release the key",
                    cause,
                  ),
              );
              const exit = yield* Effect.exit(httpEffect);
              if (Exit.isFailure(exit)) {
                yield* release;
                return yield* Effect.failCause(exit.cause);
              }
              // An error response is not stored either. `HttpApi` answers some
              // request errors, such as an unsupported content type, with a
              // response and not with a failure.
              const stored =
                exit.value.status < 400
                  ? StoredResponse.fromResponse(exit.value)
                  : undefined;
              if (stored === undefined) {
                yield* release;
                return exit.value;
              }
              yield* Effect.catchCause(
                store.complete(result.claim, stored, retention),
                (cause) =>
                  Effect.logError(
                    "effect-idempotency: could not store the response",
                    cause,
                  ),
              );
              return exit.value;
            }),
          );
        }),
      );
    }),
  ).pipe(Layer.provide(Digest.layerWebCrypto));
