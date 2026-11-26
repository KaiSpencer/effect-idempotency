import { Clock, Duration, Effect, Schedule, Schema, type Scope } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import {
  type Claim,
  type ClaimResult,
  Fingerprint,
  type IdempotencyStore,
  IdempotencyStoreError,
  StoredResponse,
} from "../IdempotencyStore.ts";

/** The options of `IdempotencyStore.layerSql`. */
export interface Options {
  /**
   * The table the keys are kept in, created if it does not exist. One name,
   * without a schema. Defaults to `effect_idempotency`.
   */
  readonly table?: string | undefined;
}

/** The table used when none is named. */
export const defaultTable = "effect_idempotency";

/** How often the store deletes the rows nobody will read again. */
export const sweepInterval = Duration.minutes(5);

/** How many rows one statement of a sweep deletes at most. */
export const sweepBatchSize = 1000;

/**
 * How long a claim that never finished is kept after its lock expired. Its
 * request may still be running and complete it, so it is not deleted with the
 * lock. A process that died leaves such a row behind for good, so it is not
 * kept for ever either.
 */
export const abandonedAfter = Duration.hours(24);

/**
 * A time as the `expires_at` column holds it: whole milliseconds since the
 * epoch. An infinite duration ends at the largest one a `number` can count
 * to, some 285,000 years from now. It is a `bigint` because that is what the
 * Postgres client sends for a `BIGINT`.
 */
const time = (millis: number): bigint =>
  BigInt(Math.min(Math.ceil(millis), Number.MAX_SAFE_INTEGER));

const fail = (cause: unknown) => new IdempotencyStoreError({ cause });

/**
 * The store, and the sweep the layer runs on a schedule, which the tests run
 * by hand. The sweep returns how many rows it deleted.
 *
 * A row is the memory store's entry: `expires_at` is the lock expiry while
 * `response` is null and the retention expiry after.
 */
export const makeWithSweep = Effect.fnUntraced(function* (
  options?: Options,
): Effect.fn.Return<
  {
    readonly store: IdempotencyStore["Service"];
    readonly sweep: Effect.Effect<number, IdempotencyStoreError>;
  },
  never,
  SqlClient.SqlClient | SecureRandom.SecureRandom
> {
  // The store's own column names must reach the database as written, whatever
  // the application has its client rename.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  const random = yield* SecureRandom.SecureRandom;
  const name = options?.table ?? defaultTable;
  const table = sql(name);

  // The statements below are written once for both: an upsert with
  // `RETURNING` and a row value on the left of `IN`.
  yield* sql.onDialectOrElse({
    pg: () => Effect.void,
    sqlite: () => Effect.void,
    orElse: () =>
      Effect.die(
        new Error(
          "effect-idempotency: IdempotencyStore.layerSql supports PostgreSQL and SQLite",
        ),
      ),
  });

  // Tried again when it fails: of two servers that start at once on a
  // database without the table, PostgreSQL lets one create it and fails the
  // other, `IF NOT EXISTS` or not. By then the table is there.
  yield* Effect.andThen(
    sql`
      CREATE TABLE IF NOT EXISTS ${table} (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        response TEXT,
        PRIMARY KEY (scope, idempotency_key)
      )
    `,
    sql`
      CREATE INDEX IF NOT EXISTS ${sql(`${name}_expires_at_idx`)}
      ON ${table} (expires_at)
    `,
  ).pipe(Effect.retry({ times: 3 }), Effect.orDie);

  // Built here and not at the top of the module: `IdempotencyStore.ts`
  // imports this file, so its schemas do not exist yet when this one loads.
  const Response = Schema.fromJsonString(Schema.toCodecJson(StoredResponse));
  const encodeResponse = Schema.encodeEffect(Response);
  const decodeRows = Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        token: Schema.String,
        fingerprint: Fingerprint,
        response: Schema.NullOr(Response),
      }),
    ),
  );

  /**
   * One statement, so that it is atomic without a transaction. It writes the
   * new claim where the key is free, which is where there is no row or the
   * row has expired, and otherwise writes the row back as it was. Either way
   * it returns the row, and the row carries this claim's token only if this
   * claim took the key.
   *
   * An insert that changed nothing where the key is held, followed by a read
   * of the row, would spare that write. But the row can be released between
   * the two, so it would have to try again, with no bound on how often.
   */
  const claim: IdempotencyStore["Service"]["claim"] = Effect.fnUntraced(
    function* ({ fingerprint, key, lockExpiry, scope }) {
      const now = yield* Clock.currentTimeMillis;
      const token = yield* random.uuidV4();
      const free = sql`${table}.expires_at <= ${time(now)}`;
      const rows = yield* sql`
        INSERT INTO ${table}
          (scope, idempotency_key, fingerprint, token, expires_at, response)
        VALUES (
          ${scope}, ${key}, ${fingerprint}, ${token},
          ${time(now + Duration.toMillis(lockExpiry))}, NULL
        )
        ON CONFLICT (scope, idempotency_key) DO UPDATE SET
          fingerprint = CASE WHEN ${free}
            THEN excluded.fingerprint ELSE ${table}.fingerprint END,
          token = CASE WHEN ${free}
            THEN excluded.token ELSE ${table}.token END,
          expires_at = CASE WHEN ${free}
            THEN excluded.expires_at ELSE ${table}.expires_at END,
          response = CASE WHEN ${free}
            THEN NULL ELSE ${table}.response END
        RETURNING token, fingerprint, response
      `.pipe(Effect.flatMap(decodeRows));
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(new Error("The claim returned no row"));
      }
      const result: ClaimResult =
        row.token === token
          ? { _tag: "Claimed", claim: { scope, key, token } }
          : row.response === null
            ? { _tag: "InProgress", fingerprint: row.fingerprint }
            : {
                _tag: "Completed",
                fingerprint: row.fingerprint,
                response: row.response,
              };
      return result;
    },
    Effect.mapError(fail),
  );

  const owned = (claim: Claim) =>
    sql`scope = ${claim.scope} AND idempotency_key = ${claim.key} AND token = ${claim.token}`;

  const complete: IdempotencyStore["Service"]["complete"] = Effect.fnUntraced(
    function* (claim, response, retention) {
      const now = yield* Clock.currentTimeMillis;
      const json = yield* encodeResponse(response);
      yield* sql`
        UPDATE ${table}
        SET response = ${json},
            expires_at = ${time(now + Duration.toMillis(retention))}
        WHERE ${owned(claim)}
      `;
    },
    Effect.mapError(fail),
  );

  const release: IdempotencyStore["Service"]["release"] = (claim) =>
    sql`DELETE FROM ${table} WHERE ${owned(claim)} AND response IS NULL`.pipe(
      Effect.asVoid,
      Effect.mapError(fail),
    );

  /**
   * Deletes the responses past their retention and the claims abandoned long
   * ago, a batch at a time so that no statement holds many rows locked.
   *
   * The condition is repeated outside the subquery. A key can be claimed
   * again between the subquery choosing its row and the delete reaching it,
   * and Postgres then checks the outer condition against the new row.
   */
  const sweepBatch = (now: number) => {
    const stale = sql`(
      (response IS NOT NULL AND expires_at <= ${time(now)})
      OR expires_at <= ${time(now - Duration.toMillis(abandonedAfter))}
    )`;
    return sql`
      DELETE FROM ${table}
      WHERE (scope, idempotency_key) IN (
        SELECT scope, idempotency_key FROM ${table}
        WHERE ${stale}
        LIMIT ${sql.literal(String(sweepBatchSize))}
      ) AND ${stale}
      RETURNING 1 AS deleted
    `.pipe(Effect.map((rows) => rows.length));
  };
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let total = 0;
    let deleted = sweepBatchSize;
    while (deleted === sweepBatchSize) {
      deleted = yield* sweepBatch(now);
      total += deleted;
    }
    return total;
  }).pipe(Effect.mapError(fail));

  return { store: { claim, complete, release }, sweep };
});

/** The store, sweeping on a schedule for as long as the scope is open. */
export const make = Effect.fnUntraced(function* (
  options?: Options,
): Effect.fn.Return<
  IdempotencyStore["Service"],
  never,
  SqlClient.SqlClient | SecureRandom.SecureRandom | Scope.Scope
> {
  const { store, sweep } = yield* makeWithSweep(options);
  yield* sweep.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "effect-idempotency: could not delete the expired keys",
        cause,
      ),
    ),
    Effect.repeat(Schedule.spaced(sweepInterval)),
    Effect.forkScoped,
  );
  return store;
});
