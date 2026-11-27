/**
 * The databases the SQL store is tested on. Every test asks a backend for a
 * database that holds nothing and gets a layer back; each build of that
 * layer is another client of the same database, as another server would be.
 *
 * - **SQLite**: a file in a temporary directory, through `bun:sqlite`.
 * - **PGlite**: PostgreSQL compiled to WebAssembly, in this process. It
 *   checks the Postgres dialect wherever `bun test` runs, but it has one
 *   connection, so nothing on it happens at the same time.
 * - **PostgreSQL**: a server, when `TEST_POSTGRES_URL` names one, through a
 *   pool of connections. This is the only one where statements truly race.
 *   CI sets the variable; see CONTRIBUTING.md to run one locally.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { PgliteClient } from "@effect/sql-pglite";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Redacted, Scope } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { IdempotencyStore } from "../../src/index.ts";
import * as sqlStore from "../../src/internal/sqlStore.ts";
import { test } from "./EffectTest.ts";

export interface Backend {
  readonly name: string;
  /**
   * Whether the database has one connection, so that a statement waits for
   * the one before it, and for a transaction to end.
   */
  readonly serial: boolean;
  /**
   * Makes a database that holds nothing and removes it when the scope
   * closes. Build the layer once for each client the test needs.
   */
  readonly database: Effect.Effect<
    Layer.Layer<SqlClient.SqlClient>,
    never,
    Scope.Scope
  >;
  /** How many random sequences the model check runs: fewer where slower. */
  readonly modelRuns: number;
  /** The time limit of a test, in milliseconds. */
  readonly timeout: number;
}

const sqlite: Backend = {
  name: "SQLite",
  serial: true,
  modelRuns: 100,
  timeout: 20_000,
  database: Effect.map(
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "effect-idempotency-"))),
      (directory) =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ),
    (directory) =>
      Layer.orDie(SqliteClient.layer({ filename: join(directory, "test.db") })),
  ),
};

// A schema for each test and not a database: one server, or one PGlite, is
// then enough for the whole run, and a test still sees nothing of another.
let schemas = 0;
const nextSchema = () => `test_${process.pid}_${++schemas}`;

// Starting PGlite takes a third of a second, so the tests share one. Bun
// runs the tests of a process one after another, and the search path, which
// is the session's, is theirs for as long as they run.
let pglitePromise: Promise<SqlClient.SqlClient> | undefined;
const pgliteClient = Effect.promise(() => {
  pglitePromise ??= Effect.runPromise(
    Effect.map(
      // The scope is never closed: the instance lasts as long as the process.
      Layer.buildWithScope(
        Layer.orDie(PgliteClient.layer()),
        Scope.makeUnsafe(),
      ),
      (context) => Context.get(context, SqlClient.SqlClient),
    ),
  );
  return pglitePromise;
});

const pglite: Backend = {
  name: "PGlite",
  serial: true,
  modelRuns: 30,
  timeout: 30_000,
  database: Effect.gen(function* () {
    const sql = yield* pgliteClient;
    const schema = nextSchema();
    yield* Effect.acquireRelease(
      Effect.orDie(
        Effect.andThen(
          sql`CREATE SCHEMA ${sql(schema)}`,
          sql`SET search_path TO ${sql(schema)}`,
        ),
      ),
      () => Effect.orDie(sql`DROP SCHEMA ${sql(schema)} CASCADE`),
    );
    return Layer.succeed(SqlClient.SqlClient, sql);
  }),
};

const postgresUrl = process.env.TEST_POSTGRES_URL;

const postgres = (url: string): Backend => ({
  name: "PostgreSQL",
  serial: false,
  modelRuns: 30,
  timeout: 30_000,
  database: Effect.gen(function* () {
    const schema = nextSchema();
    const admin = Layer.orDie(
      PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }),
    );
    const run = (
      statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>,
    ) =>
      Effect.flatMap(SqlClient.SqlClient, statement).pipe(
        Effect.provide(admin),
        Effect.orDie,
      );
    yield* Effect.acquireRelease(
      run((sql) => sql`CREATE SCHEMA ${sql(schema)}`),
      () => run((sql) => sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`),
    );
    return Layer.orDie(
      PgClient.layer({
        url: Redacted.make(url),
        maxConnections: 10,
        // Each connection of the pool starts in the test's schema.
        startupParameters: { search_path: schema },
      }),
    );
  }),
});

export const backends: ReadonlyArray<Backend> = [
  sqlite,
  pglite,
  ...(postgresUrl === undefined ? [] : [postgres(postgresUrl)]),
];

/**
 * Says in the test report that the PostgreSQL tests did not run, and fails
 * in CI, where they always should: a run that silently left them out would
 * look as green as one that passed them.
 */
export const reportMissingPostgres = (): void => {
  if (postgresUrl !== undefined) return;
  const name = "PostgreSQL: set TEST_POSTGRES_URL to run these";
  if (process.env.CI) {
    test(name, () => {
      throw new Error("TEST_POSTGRES_URL is not set in CI");
    });
  } else {
    test.skip(name, () => {});
  }
};

/**
 * The SQL store on a database of its own, without the timer that
 * `IdempotencyStore.layerSql` sweeps on. Under the test clock a step of a day
 * would run that sweep hundreds of times. The sweep has tests of its own, and
 * the model check runs it between any two steps.
 */
export const storeLayer = (
  backend: Backend,
  options?: sqlStore.Options,
): Layer.Layer<IdempotencyStore.IdempotencyStore> =>
  Layer.unwrap(
    Effect.map(backend.database, (client) =>
      Layer.effect(
        IdempotencyStore.IdempotencyStore,
        Effect.map(sqlStore.makeWithSweep(options), ({ store }) => store),
      ).pipe(Layer.provide([client, SecureRandom.layerWebCrypto])),
    ),
  );

/**
 * `IdempotencyStore.layerSql` as an application provides it, on `database`
 * or, without one, on a database of its own. For tests on the real clock.
 */
export const layerSqlOn = (
  backend: Backend,
  database?: Layer.Layer<SqlClient.SqlClient>,
): Layer.Layer<IdempotencyStore.IdempotencyStore> =>
  database === undefined
    ? Layer.unwrap(
        Effect.map(backend.database, (client) =>
          Layer.provide(IdempotencyStore.layerSql(), client),
        ),
      )
    : Layer.provide(IdempotencyStore.layerSql(), database);
