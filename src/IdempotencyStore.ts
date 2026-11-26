/**
 * Where idempotency keys and their stored responses live.
 *
 * The middleware asks the store for three things: claim a key, complete a
 * claim with a response, and release a claim. Everything else (comparing
 * fingerprints, choosing a status code) is the middleware's work, so a store
 * holds no HTTP logic.
 *
 * @module
 */
import { Context, type Duration, type Effect, Layer, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import type { SqlClient } from "effect/sql";
import type { IdempotencyKey } from "./IdempotencyKey.ts";
import * as memoryStore from "./internal/memoryStore.ts";
import * as sqlStore from "./internal/sqlStore.ts";

/**
 * What makes two requests the same request. The middleware computes it and a
 * store only keeps it and gives it back.
 */
export const Fingerprint = Schema.String.pipe(Schema.brand("Fingerprint"));

/** The type of a {@link Fingerprint}. */
export type Fingerprint = typeof Fingerprint.Type;

/**
 * A response as the store keeps it.
 *
 * It is a schema so that a store outside the process can write it down:
 * `Schema.toCodecJson(StoredResponse)` encodes it as JSON, with the body in
 * base64.
 */
export const StoredResponse = Schema.Struct({
  status: Schema.Int,
  statusText: Schema.optional(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  /** One `Set-Cookie` header value per cookie. */
  cookies: Schema.Array(Schema.String),
  /** Absent for a response without a body. */
  body: Schema.optional(Schema.Uint8Array),
});

/** The type of a {@link StoredResponse}. */
export type StoredResponse = typeof StoredResponse.Type;

/**
 * The right to finish one key. The store issues a new `token` with every
 * claim, so a request whose claim expired cannot complete or release the
 * claim of the request that took the key after it.
 */
export interface Claim {
  readonly scope: string;
  readonly key: IdempotencyKey;
  readonly token: string;
}

/** What {@link IdempotencyStore} `claim` found. */
export type ClaimResult =
  /** The key was free, or had expired. The caller now owns it. */
  | { readonly _tag: "Claimed"; readonly claim: Claim }
  /** Another request owns the key and has not finished. */
  | { readonly _tag: "InProgress"; readonly fingerprint: Fingerprint }
  /** A request finished with this key and its response is stored. */
  | {
      readonly _tag: "Completed";
      readonly fingerprint: Fingerprint;
      readonly response: StoredResponse;
    };

/** The store could not be reached or could not answer. */
export class IdempotencyStoreError extends Schema.TaggedError<IdempotencyStoreError>()(
  "IdempotencyStoreError",
  { cause: Schema.Defect() },
) {}

/**
 * The store service.
 *
 * A key is unique within its `scope`; the same key in two scopes is two keys.
 * A store reads the time from Effect's `Clock`.
 */
export class IdempotencyStore extends Context.Service<
  IdempotencyStore,
  {
    /**
     * Claims the key if it is free. This must be atomic: of any number of
     * concurrent claims for a free key, exactly one gets `Claimed`.
     *
     * A claim holds the key for `lockExpiry`. After that the key can be
     * claimed again, and the new claim voids the old one. Until then, and
     * for as long as nobody claims the key again, the claim can still be
     * completed or released.
     *
     * When the key is taken, the result carries the fingerprint the key was
     * claimed with.
     */
    readonly claim: (options: {
      readonly scope: string;
      readonly key: IdempotencyKey;
      readonly fingerprint: Fingerprint;
      readonly lockExpiry: Duration.Duration;
    }) => Effect.Effect<ClaimResult, IdempotencyStoreError>;
    /**
     * Stores the response for a claim and keeps it for `retention`, counted
     * from now, after which the key is free again. A claim can complete more
     * than once, and the last response replaces the one before: the
     * middleware does so when the response changes before it is sent. Does
     * nothing if the claim is void, or if its response has been stored and
     * the retention of that response is over.
     */
    readonly complete: (
      claim: Claim,
      response: StoredResponse,
      retention: Duration.Duration,
    ) => Effect.Effect<void, IdempotencyStoreError>;
    /**
     * Frees the key of a claim that has not completed. Does nothing if the
     * claim is void or has completed.
     */
    readonly release: (
      claim: Claim,
    ) => Effect.Effect<void, IdempotencyStoreError>;
  }
>()("effect-idempotency/IdempotencyStore") {}

/**
 * A store in the process's memory.
 *
 * It is lost on restart and not shared between processes, so it suits tests,
 * development, and a server that runs as one process.
 */
export const layerMemory: Layer.Layer<IdempotencyStore> = Layer.effect(
  IdempotencyStore,
  memoryStore.make,
);

/** The options of {@link layerSql}. */
export type SqlOptions = sqlStore.Options;

/**
 * A store in a SQL database, through the `SqlClient` the application already
 * provides. It supports PostgreSQL and SQLite 3.35 or later, and the layer
 * fails to build on another database.
 *
 * Every server that shares the database shares the keys, and they survive a
 * restart. The layer creates its table and an index if they do not exist, so
 * the database user needs the right to. For as long as the layer is built it
 * also deletes, every few minutes, the responses past their retention and the
 * claims a dead process left behind.
 *
 * A key expires by the `Clock` of the server that reads it, against a time
 * the server that wrote it set. Keep the servers' clocks within a small part
 * of the lock expiry and of the retention of each other.
 *
 * ```ts
 * const StoreLive = IdempotencyStore.layerSql().pipe(
 *   Layer.provide(PgClient.layer({ url })),
 * )
 * ```
 */
export const layerSql = (
  options?: SqlOptions,
): Layer.Layer<IdempotencyStore, never, SqlClient.SqlClient> =>
  Layer.effect(IdempotencyStore, sqlStore.make(options)).pipe(
    Layer.provide(SecureRandom.layerWebCrypto),
  );
