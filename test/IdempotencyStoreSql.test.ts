/**
 * `IdempotencyStore.layerSql`, on every database in `support/sqlBackends.ts`.
 *
 * The contract every store passes comes first. The rest is what only a store
 * in a database can get wrong: its table, sharing it between servers, the
 * rows it leaves behind, a database that fails, and transactions.
 */
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Logger,
  Scope,
} from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SecureRandom } from "effect/crypto";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlError, Statement } from "effect/sql";
import { TestClock } from "effect/testing";
import { IdempotencyKey, IdempotencyStore } from "../src/index.ts";
import * as sqlStore from "../src/internal/sqlStore.ts";
import { describe, expect, it, test } from "./support/EffectTest.ts";
import {
  type Backend,
  backends,
  reportMissingPostgres,
  storeLayer,
} from "./support/sqlBackends.ts";
import { storeContract } from "./support/storeContract.ts";
import { agreesWithMemoryStore } from "./support/storeModel.ts";

type Store = IdempotencyStore.IdempotencyStore["Service"];

const lockExpiry = Duration.minutes(5);
const retention = Duration.hours(1);

const response: IdempotencyStore.StoredResponse = {
  status: 201,
  statusText: "Created",
  headers: { "content-type": "application/json" },
  cookies: ["session=abc; Path=/"],
  body: new Uint8Array([123, 125]),
};
/** `response` as the `response` column holds it. */
const responseJson =
  '{"status":201,"statusText":"Created","headers":{"content-type":"application/json"},"cookies":["session=abc; Path=/"],"body":"e30="}';

const claim = (store: Store, key: string, fingerprint = "fingerprint") =>
  store.claim({
    scope: "scope",
    key: IdempotencyKey.IdempotencyKey.make(key),
    fingerprint: IdempotencyStore.Fingerprint.make(fingerprint),
    lockExpiry,
  });

/** Claims a free key and returns the claim. */
const claimed = (store: Store, key: string) =>
  Effect.flatMap(claim(store, key), (result) =>
    result._tag === "Claimed"
      ? Effect.succeed(result.claim)
      : Effect.die(new Error(`Expected to claim "${key}", got ${result._tag}`)),
  );

const tag = (store: Store, key: string) =>
  Effect.map(claim(store, key), (result) => result._tag);

/** Waits, in real time, for `done` to hold, and says whether it came to. */
const until = (done: Effect.Effect<boolean, unknown>) =>
  TestClock.withLive(
    Effect.gen(function* () {
      for (let waited = 0; waited < 2000; waited += 5) {
        if (yield* Effect.orDie(done)) return true;
        yield* Effect.sleep("5 millis");
      }
      return false;
    }),
  );

/**
 * A database that holds nothing, a client of it, and ways to get another
 * client and to open the store through one.
 */
const setup = (backend: Backend) =>
  Effect.gen(function* () {
    const database = yield* backend.database;
    /** Another client, as another server on the database would have. */
    const connect = Effect.map(Layer.build(database), (context) =>
      Context.get(context, SqlClient.SqlClient).withoutTransforms(),
    );
    const sql = yield* connect;
    /** What building `layerSql` does, without the timer for the sweep. */
    const open = (
      client: SqlClient.SqlClient = sql,
      options?: sqlStore.Options,
    ) =>
      sqlStore
        .makeWithSweep(options)
        .pipe(
          Effect.provideService(SqlClient.SqlClient, client),
          Effect.provide(SecureRandom.layerWebCrypto),
        );
    const rows = (table = sqlStore.defaultTable) =>
      Effect.map(
        sql<{
          scope: string;
          idempotency_key: string;
          fingerprint: string;
          token: string;
          expires_at: number | bigint | string;
          response: string | null;
        }>`SELECT * FROM ${sql(table)} ORDER BY idempotency_key`,
        // A `BIGINT` comes back as a number, a bigint or a string, by client.
        (found) =>
          found.map((row) => ({ ...row, expires_at: Number(row.expires_at) })),
      );
    /** Writes a row as the store would, at a time of the test's choosing. */
    const insert = (
      entries: ReadonlyArray<{
        readonly key: string;
        readonly expiresAt: number;
        readonly response: string | null;
      }>,
    ) => {
      const values = entries.map((entry) => ({
        scope: "scope",
        idempotency_key: entry.key,
        fingerprint: "fingerprint",
        token: `written-by-hand-${entry.key}`,
        expires_at: BigInt(entry.expiresAt),
        response: entry.response,
      }));
      return Arr.isArrayNonEmpty(values)
        ? Effect.asVoid(
            sql`INSERT INTO ${sql(sqlStore.defaultTable)} ${sql.insert(values)}`,
          )
        : Effect.void;
    };
    return { connect, database, insert, open, rows, sql };
  });

reportMissingPostgres();

for (const backend of backends) {
  storeContract(`layerSql on ${backend.name}`, storeLayer(backend), {
    modelRuns: backend.modelRuns,
    timeout: backend.timeout,
  });

  const test = <A, E>(
    label: string,
    self: () => Effect.Effect<A, E, Scope.Scope>,
  ): void => {
    it.effect(label, self, backend.timeout);
  };

  describe(`layerSql on ${backend.name}: its table`, () => {
    test("creates its table and index, and leaves them be when they exist", () =>
      Effect.gen(function* () {
        const { open, sql } = yield* setup(backend);
        const first = yield* open();
        yield* first.store.complete(
          yield* claimed(first.store, "k"),
          response,
          retention,
        );

        // Opening it again runs the same statements on the same table.
        const second = yield* open();
        expect(yield* tag(second.store, "k")).toBe("Completed");

        const indexes = yield* sql.onDialectOrElse({
          pg: () =>
            sql<{ name: string }>`
              SELECT indexname AS name FROM pg_indexes
              WHERE schemaname = current_schema()
                AND tablename = ${sqlStore.defaultTable}`,
          orElse: () =>
            sql<{ name: string }>`
              SELECT name FROM sqlite_master
              WHERE type = 'index' AND tbl_name = ${sqlStore.defaultTable}`,
        });
        expect(indexes.map((index) => index.name)).toContain(
          "effect_idempotency_expires_at_idx",
        );
      }));

    test("keeps to the table it is given, also one whose name needs quoting", () =>
      Effect.gen(function* () {
        const { open, rows, sql } = yield* setup(backend);
        const table = 'Idempotency "Keys"';
        const named = yield* open(sql, { table });
        yield* claimed(named.store, "k");

        expect(yield* rows(table)).toHaveLength(1);
        // Nothing went to the default table, which was never made.
        expect(Exit.isFailure(yield* Effect.exit(rows()))).toBe(true);

        // And a store on another table has keys of its own.
        const other = yield* open();
        expect(yield* tag(other.store, "k")).toBe("Claimed");
        expect(yield* tag(named.store, "k")).toBe("InProgress");
      }));

    // PostgreSQL cuts a name off at 63 bytes, and the index is named after
    // the table. The longest table name allowed is the one whose index name
    // is exactly that long.
    test("takes the longest table name that leaves room for its index's", () =>
      Effect.gen(function* () {
        const { open, rows, sql } = yield* setup(backend);
        const table = "t".repeat(48);
        const { store } = yield* open(sql, { table });
        yield* claimed(store, "k");
        expect(yield* rows(table)).toHaveLength(1);

        const indexes = yield* sql.onDialectOrElse({
          pg: () =>
            sql<{ name: string }>`
              SELECT indexname AS name FROM pg_indexes
              WHERE schemaname = current_schema() AND tablename = ${table}`,
          orElse: () =>
            sql<{ name: string }>`
              SELECT name FROM sqlite_master
              WHERE type = 'index' AND tbl_name = ${table}`,
        });
        expect(indexes.map((index) => index.name)).toContain(
          `${table}_expires_at_idx`,
        );
      }));

    // The rows outlive the version of the package that wrote them, so what a
    // row looks like is a promise. These two tests are that promise: change
    // them only together with a migration.
    test("writes a claim and its response as documented", () =>
      Effect.gen(function* () {
        const { open, rows } = yield* setup(backend);
        const { store } = yield* open();
        yield* TestClock.adjust("10 seconds");

        const first = yield* claimed(store, "k");
        expect(yield* rows()).toEqual([
          {
            scope: "scope",
            idempotency_key: "k",
            fingerprint: "fingerprint",
            token: first.token,
            expires_at: 10_000 + Duration.toMillis(lockExpiry),
            response: null,
          },
        ]);

        yield* TestClock.adjust("1 second");
        yield* store.complete(first, response, retention);
        expect(yield* rows()).toEqual([
          {
            scope: "scope",
            idempotency_key: "k",
            fingerprint: "fingerprint",
            token: first.token,
            expires_at: 11_000 + Duration.toMillis(retention),
            response: responseJson,
          },
        ]);
      }));

    test("reads a row written as documented", () =>
      Effect.gen(function* () {
        const { insert, open } = yield* setup(backend);
        const { store } = yield* open();
        yield* insert([{ key: "k", expiresAt: 1, response: responseJson }]);

        expect(yield* claim(store, "k", "other")).toEqual({
          _tag: "Completed",
          fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
          response,
        });
        yield* TestClock.adjust(1);
        expect(yield* tag(store, "k")).toBe("Claimed");
      }));

    test("can be opened by many servers at once on a database that holds nothing", () =>
      Effect.gen(function* () {
        const { connect, open } = yield* setup(backend);
        const clients = yield* Effect.all(
          Array.from({ length: 8 }, () => connect),
        );
        const stores = yield* Effect.all(
          clients.map((client) => open(client)),
          { concurrency: "unbounded" },
        );

        expect(stores).toHaveLength(8);
        expect(yield* tag(stores[0]!.store, "k")).toBe("Claimed");
        expect(yield* tag(stores[7]!.store, "k")).toBe("InProgress");
      }));
  });

  describe(`layerSql on ${backend.name}: servers that share a database`, () => {
    test("replays a response to a server started after the first one stopped", () =>
      Effect.gen(function* () {
        const { connect, open } = yield* setup(backend);
        // The first server, its client closed with its scope.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { store } = yield* open(yield* connect);
            yield* store.complete(
              yield* claimed(store, "k"),
              response,
              retention,
            );
          }),
        );

        const { store } = yield* open(yield* connect);
        expect(yield* claim(store, "k")).toMatchObject({
          _tag: "Completed",
          response,
        });
      }));

    test("shows each server what the other did with a key", () =>
      Effect.gen(function* () {
        const { connect, open } = yield* setup(backend);
        const a = (yield* open(yield* connect)).store;
        const b = (yield* open(yield* connect)).store;

        const first = yield* claimed(a, "k");
        expect(yield* claim(b, "k", "other")).toEqual({
          _tag: "InProgress",
          fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
        });
        yield* a.complete(first, response, retention);
        expect(yield* claim(b, "k")).toMatchObject({
          _tag: "Completed",
          response,
        });

        yield* a.release(yield* claimed(a, "released"));
        expect(yield* tag(b, "released")).toBe("Claimed");
      }));

    test("gives one of two servers a key they race for", () =>
      Effect.gen(function* () {
        const { connect, open } = yield* setup(backend);
        const a = (yield* open(yield* connect)).store;
        const b = (yield* open(yield* connect)).store;

        for (const key of ["free", "expired"]) {
          if (key === "expired") {
            yield* claimed(a, key);
            yield* TestClock.adjust(lockExpiry);
          }
          const results = yield* Effect.all(
            Array.from({ length: 100 }, (_, index) =>
              tag(index % 2 === 0 ? a : b, key),
            ),
            { concurrency: "unbounded" },
          );
          expect(results.filter((result) => result === "Claimed")).toHaveLength(
            1,
          );
          expect(
            results.filter((result) => result === "InProgress"),
          ).toHaveLength(99);
        }
      }));

    // A token that only counted the claims of one server would be the same
    // on two of them, and one server could then finish the other's claim.
    test("does not let a server finish a claim of the same key by another", () =>
      Effect.gen(function* () {
        const { connect, open } = yield* setup(backend);
        const a = (yield* open(yield* connect)).store;
        const b = (yield* open(yield* connect)).store;

        const first = yield* claimed(a, "k");
        yield* TestClock.adjust(lockExpiry);
        const second = yield* claimed(b, "k");
        expect(second.token).not.toBe(first.token);

        yield* a.complete(first, response, retention);
        expect(yield* tag(a, "k")).toBe("InProgress");
        yield* a.release(first);
        expect(yield* tag(b, "k")).toBe("InProgress");

        yield* b.complete(second, { ...response, status: 202 }, retention);
        expect(yield* claim(a, "k")).toMatchObject({
          _tag: "Completed",
          response: { status: 202 },
        });
      }));
  });

  describe(`layerSql on ${backend.name}: when something is wrong`, () => {
    test("fails with IdempotencyStoreError when the database refuses", () =>
      Effect.gen(function* () {
        const { open, sql } = yield* setup(backend);
        const { store, sweep } = yield* open();
        const first = yield* claimed(store, "k");
        yield* sql`DROP TABLE ${sql(sqlStore.defaultTable)}`;

        for (const operation of [
          claim(store, "k"),
          store.complete(first, response, retention),
          store.release(first),
          sweep,
        ]) {
          const error = yield* Effect.flip(operation);
          expect(error).toBeInstanceOf(IdempotencyStore.IdempotencyStoreError);
          expect(SqlError.isSqlError(error.cause)).toBe(true);
        }
      }));

    test("fails, and does not hand out the key, when a stored response cannot be read", () =>
      Effect.gen(function* () {
        const { insert, open } = yield* setup(backend);
        const { store } = yield* open();
        const expiresAt = Duration.toMillis(retention);
        yield* insert([
          { key: "cut-off", expiresAt, response: '{"status":20' },
          { key: "not-a-response", expiresAt, response: '{"status":"200"}' },
        ]);

        for (const key of ["cut-off", "not-a-response"]) {
          expect(yield* Effect.flip(claim(store, key))).toBeInstanceOf(
            IdempotencyStore.IdempotencyStoreError,
          );
        }

        // It is in the way for no longer than its retention.
        yield* TestClock.adjust(retention);
        expect(yield* tag(store, "cut-off")).toBe("Claimed");
      }));

    // PostgreSQL text cannot hold a NUL character. Such a scope is a bug of
    // the application, and the answer to it is a failed claim, after which
    // the handler does not run, and never a claim under some other scope.
    test("takes a scope with a NUL character, or fails where the database cannot hold one", () =>
      Effect.gen(function* () {
        const { open, sql } = yield* setup(backend);
        const { store } = yield* open();
        const withNul = (scope: string) =>
          Effect.exit(
            store.claim({
              scope,
              key: IdempotencyKey.IdempotencyKey.make("k"),
              fingerprint: IdempotencyStore.Fingerprint.make("fingerprint"),
              lockExpiry,
            }),
          );

        const first = yield* withNul("a\0b");
        if (sql.onDialectOrElse({ pg: () => true, orElse: () => false })) {
          expect(Exit.isFailure(first)).toBe(true);
          expect(yield* Effect.flip(first)).toBeInstanceOf(
            IdempotencyStore.IdempotencyStoreError,
          );
        } else {
          expect(first).toMatchObject(Exit.succeed({ _tag: "Claimed" }));
          expect(yield* withNul("a\0b")).toMatchObject(
            Exit.succeed({ _tag: "InProgress" }),
          );
        }
        // Either way, the scopes around it are untouched.
        expect(yield* withNul("a")).toMatchObject(
          Exit.succeed({ _tag: "Claimed" }),
        );
        expect(yield* withNul("a\0")).not.toMatchObject(
          Exit.succeed({ _tag: "InProgress" }),
        );
      }));
  });

  describe(`layerSql on ${backend.name}: the sweep`, () => {
    test("deletes a response when its retention is over, and not before", () =>
      Effect.gen(function* () {
        const { open, rows } = yield* setup(backend);
        const { store, sweep } = yield* open();
        yield* store.complete(yield* claimed(store, "k"), response, retention);

        yield* TestClock.adjust(
          Duration.subtract(retention, Duration.millis(1)),
        );
        expect(yield* sweep).toBe(0);
        expect(yield* rows()).toHaveLength(1);

        yield* TestClock.adjust(Duration.millis(1));
        expect(yield* sweep).toBe(1);
        expect(yield* rows()).toHaveLength(0);
      }));

    test("keeps a claim whose lock expired, which its request can still complete", () =>
      Effect.gen(function* () {
        const { open } = yield* setup(backend);
        const { store, sweep } = yield* open();
        const first = yield* claimed(store, "k");

        yield* TestClock.adjust(Duration.times(lockExpiry, 3));
        expect(yield* sweep).toBe(0);
        yield* store.complete(first, response, retention);
        expect(yield* tag(store, "k")).toBe("Completed");
      }));

    test("deletes a claim that was abandoned, a day after its lock expired", () =>
      Effect.gen(function* () {
        const { open, rows } = yield* setup(backend);
        const { store, sweep } = yield* open();
        const first = yield* claimed(store, "k");

        yield* TestClock.adjust(
          Duration.sum(
            lockExpiry,
            Duration.subtract(sqlStore.abandonedAfter, Duration.millis(1)),
          ),
        );
        expect(yield* sweep).toBe(0);

        yield* TestClock.adjust(Duration.millis(1));
        expect(yield* sweep).toBe(1);
        expect(yield* rows()).toHaveLength(0);

        // Its request, should it still be running, completes nothing now.
        yield* store.complete(first, response, retention);
        expect(yield* rows()).toHaveLength(0);
      }));

    test("keeps a key that was claimed again after its response expired", () =>
      Effect.gen(function* () {
        const { open } = yield* setup(backend);
        const { store, sweep } = yield* open();
        yield* store.complete(yield* claimed(store, "k"), response, retention);
        yield* TestClock.adjust(retention);
        const second = yield* claimed(store, "k");

        expect(yield* sweep).toBe(0);
        yield* store.complete(second, response, retention);
        expect(yield* tag(store, "k")).toBe("Completed");
      }));

    test("keeps a response with an infinite retention", () =>
      Effect.gen(function* () {
        const { open } = yield* setup(backend);
        const { store, sweep } = yield* open();
        yield* store.complete(
          yield* claimed(store, "k"),
          response,
          Duration.infinity,
        );

        yield* TestClock.adjust(Duration.days(30));
        expect(yield* sweep).toBe(0);
        expect(yield* tag(store, "k")).toBe("Completed");
      }));

    test("deletes more rows than one statement takes, and only the expired", () =>
      Effect.gen(function* () {
        const { insert, open, rows } = yield* setup(backend);
        const { sweep } = yield* open();
        yield* TestClock.adjust("1 hour");
        const expired = sqlStore.sweepBatchSize * 2 + 500;
        const now = Duration.toMillis(Duration.hours(1));
        yield* insert(
          Array.from({ length: expired }, (_, index) => ({
            key: `expired-${index}`,
            expiresAt: now - (index % 1000),
            response: responseJson,
          })),
        );
        yield* insert([
          { key: "stored", expiresAt: now + 1, response: responseJson },
          { key: "running", expiresAt: now + 1, response: null },
          { key: "running-late", expiresAt: now - 1, response: null },
        ]);

        expect(yield* sweep).toBe(expired);
        expect((yield* rows()).map((row) => row.idempotency_key)).toEqual([
          "running",
          "running-late",
          "stored",
        ]);
      }));

    // On a pool of connections the sweep and the claims truly interleave. A
    // sweep that deleted a row another request had just taken over would
    // free a key whose handler is running.
    test("never deletes a key a request claims while it runs", () =>
      Effect.gen(function* () {
        const { insert, open } = yield* setup(backend);
        const { store, sweep } = yield* open();
        const keys = Array.from({ length: 200 }, (_, index) => `k${index}`);
        yield* insert(
          keys.map((key) => ({ key, expiresAt: 1, response: responseJson })),
        );
        yield* TestClock.adjust(1);

        const [claims] = yield* Effect.all(
          [
            Effect.all(
              keys.map((key) => claimed(store, key)),
              { concurrency: "unbounded" },
            ),
            Effect.all(
              Array.from({ length: 20 }, () => sweep),
              { concurrency: "unbounded" },
            ),
          ],
          { concurrency: "unbounded" },
        );

        for (const held of claims) {
          expect(yield* tag(store, held.key)).toBe("InProgress");
          yield* store.complete(held, response, retention);
          expect(yield* tag(store, held.key)).toBe("Completed");
        }
      }));

    // The one order of events in which the delete has to look at a row a
    // second time. PostgreSQL makes the sweep wait for a row another
    // transaction has written, and then hands it the row as that transaction
    // left it: no longer the expired response the sweep chose to delete.
    test("does not delete a key whose claim commits while the sweep waits for its row", () =>
      Effect.gen(function* () {
        const { insert, open, sql } = yield* setup(backend);
        const { store, sweep } = yield* open();
        yield* insert([{ key: "k", expiresAt: 1, response: responseJson }]);
        yield* TestClock.adjust(1);
        const written = yield* Latch.make(false);
        const commit = yield* Latch.make(false);

        // The claim writes the row and holds it until the test lets its
        // transaction end.
        const claiming = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.tap(claimed(store, "k"), () =>
              Effect.andThen(written.open, commit.await),
            ),
          ),
        );
        yield* written.await;
        const sweeping = yield* Effect.forkChild(sweep);
        if (backend.serial) {
          // The sweep waits for the connection, and there is nothing to see
          // of that from outside. It runs once the transaction has ended.
          yield* TestClock.withLive(Effect.sleep("20 millis"));
        } else {
          // The sweep has reached the row and waits for the claim to commit.
          const waiting = Effect.map(
            sql<{ waiting: number | bigint | string }>`
              SELECT COUNT(*) AS waiting FROM pg_stat_activity
              WHERE wait_event_type = 'Lock'
                AND datname = current_database()
                AND pid <> pg_backend_pid()`,
            (found) => Number(found[0]?.waiting) > 0,
          );
          expect(yield* until(waiting)).toBe(true);
        }
        yield* commit.open;
        expect(yield* Fiber.join(sweeping)).toBe(0);

        const held = yield* Fiber.join(claiming);
        expect(yield* tag(store, "k")).toBe("InProgress");
        yield* store.complete(held, response, retention);
        expect(yield* tag(store, "k")).toBe("Completed");
      }));

    test("shows in no answer that it ran, whatever the order of events", () =>
      Effect.gen(function* () {
        const { open } = yield* setup(backend);
        const { store, sweep } = yield* open();
        yield* agreesWithMemoryStore(store, {
          runs: backend.modelRuns,
          housekeeping: sweep,
        });
      }));

    test("runs when the layer is built, then on a timer, until the layer is released", () =>
      Effect.gen(function* () {
        const { insert, open, rows, sql } = yield* setup(backend);
        // Only to make the table, so that a row can be there before the layer.
        yield* open();
        const expired = (key: string) =>
          insert([{ key, expiresAt: 0, response: responseJson }]);
        const live = <A, E>(effect: Effect.Effect<A, E>) =>
          TestClock.withLive(effect);
        /** Waits, in real time, for the table to be empty. */
        const swept = live(
          Effect.gen(function* () {
            for (let waited = 0; waited < 2000; waited += 5) {
              if ((yield* rows()).length === 0) return true;
              yield* Effect.sleep("5 millis");
            }
            return false;
          }),
        );
        const settle = live(Effect.sleep("100 millis"));

        yield* expired("before");
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          Layer.provide(
            IdempotencyStore.layerSql(),
            Layer.succeed(SqlClient.SqlClient, sql),
          ),
          scope,
        );
        expect(yield* swept).toBe(true);

        // Nothing more happens until the interval has passed.
        yield* expired("during");
        yield* TestClock.adjust(
          Duration.subtract(sqlStore.sweepInterval, Duration.millis(1)),
        );
        yield* settle;
        expect(yield* rows()).toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));
        expect(yield* swept).toBe(true);

        // The layer's store is the one the rest of this file tests.
        const store = Context.get(context, IdempotencyStore.IdempotencyStore);
        expect(yield* tag(store, "k")).toBe("Claimed");
        yield* store.release(yield* claimed(store, "other"));

        yield* Scope.close(scope, Exit.void);
        yield* sql`DELETE FROM ${sql(sqlStore.defaultTable)}`;
        yield* expired("after");
        yield* TestClock.adjust(Duration.times(sqlStore.sweepInterval, 3));
        yield* settle;
        expect(yield* rows()).toHaveLength(1);
      }));

    // A background task that stops at its first failure is never noticed:
    // the table would only grow.
    test("warns when a sweep fails, and sweeps again at the next interval", () =>
      Effect.gen(function* () {
        const { insert, open, rows, sql } = yield* setup(backend);
        yield* open();
        const table = sql(sqlStore.defaultTable);
        const warnings: Array<unknown> = [];
        const swept = until(Effect.map(rows(), (found) => found.length === 0));

        yield* insert([{ key: "first", expiresAt: 0, response: responseJson }]);
        yield* Layer.build(
          Layer.provide(
            IdempotencyStore.layerSql(),
            Layer.succeed(SqlClient.SqlClient, sql),
          ),
        ).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((log) => {
                if (log.logLevel === "Warn") warnings.push(log.message);
              }),
            ]),
          ),
        );
        expect(yield* swept).toBe(true);
        expect(warnings).toEqual([]);

        // The table is out of reach for one sweep.
        yield* sql`ALTER TABLE ${table} RENAME TO moved`;
        yield* TestClock.adjust(sqlStore.sweepInterval);
        expect(yield* until(Effect.sync(() => warnings.length === 1))).toBe(
          true,
        );
        expect(JSON.stringify(warnings[0])).toContain(
          "could not delete the expired keys",
        );

        yield* sql`ALTER TABLE moved RENAME TO ${table}`;
        yield* insert([
          { key: "second", expiresAt: 0, response: responseJson },
        ]);
        yield* TestClock.adjust(sqlStore.sweepInterval);
        expect(yield* swept).toBe(true);
        expect(warnings).toHaveLength(1);
      }));
  });

  describe(`layerSql on ${backend.name}: in a transaction`, () => {
    test("a claim in a transaction that is rolled back was never made", () =>
      Effect.gen(function* () {
        const { open, sql } = yield* setup(backend);
        const { store } = yield* open();

        // The error is the test's own: the claim before it was made.
        expect(
          yield* Effect.flip(
            sql.withTransaction(
              Effect.andThen(claimed(store, "k"), Effect.fail("rolled back")),
            ),
          ),
        ).toBe("rolled back");
        expect(yield* tag(store, "k")).toBe("Claimed");
      }));

    // What a transactional mode would rest on: the handler's own write and
    // the stored response are in the database together, or neither is.
    test("a completion shares the fate of the writes in its transaction", () =>
      Effect.gen(function* () {
        const { open, sql } = yield* setup(backend);
        const { store } = yield* open();
        yield* sql`CREATE TABLE payments (id TEXT PRIMARY KEY)`;
        const payments = Effect.map(
          sql`SELECT id FROM payments`,
          (found) => found.length,
        );
        const first = yield* claimed(store, "k");
        const pay = Effect.andThen(
          sql`INSERT INTO payments (id) VALUES ('pay_1')`,
          store.complete(first, response, retention),
        );

        // The error is the test's own: both writes before it were made.
        expect(
          yield* Effect.flip(
            sql.withTransaction(
              Effect.andThen(pay, Effect.fail("rolled back")),
            ),
          ),
        ).toBe("rolled back");
        expect(yield* payments).toBe(0);
        expect(yield* tag(store, "k")).toBe("InProgress");

        yield* sql.withTransaction(pay);
        expect(yield* payments).toBe(1);
        expect(yield* tag(store, "k")).toBe("Completed");
      }));
  });
}

describe("layerSql", () => {
  test("says why a table name cannot be used", () => {
    expect(sqlStore.refuseTable("effect_idempotency")).toBeUndefined();
    expect(sqlStore.refuseTable('Idempotency "Keys"')).toBeUndefined();
    expect(sqlStore.refuseTable("")).toContain("empty");
    expect(sqlStore.refuseTable("app.keys")).toContain("dot");
    // 48 bytes are allowed, in whatever characters they come.
    expect(sqlStore.refuseTable("t".repeat(48))).toBeUndefined();
    expect(sqlStore.refuseTable("t".repeat(49))).toContain("48 bytes");
    expect(sqlStore.refuseTable("ż".repeat(24))).toBeUndefined();
    expect(sqlStore.refuseTable("ż".repeat(25))).toContain("48 bytes");
    expect(sqlStore.refuseTable("🔑".repeat(12))).toBeUndefined();
    expect(sqlStore.refuseTable("🔑".repeat(13))).toContain("48 bytes");
  });

  it.effect(
    "does not build, and makes no table, for a name it cannot use",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqliteClient.make({ filename: ":memory:" }).pipe(
          Effect.provide(Reactivity.layer),
        );
        // A schema of that name exists, so the table could have been made.
        yield* sql`ATTACH DATABASE ':memory:' AS app`;
        for (const table of ["app.keys", "t".repeat(49)]) {
          const exit = yield* Effect.exit(
            Layer.build(
              Layer.provide(
                IdempotencyStore.layerSql({ table }),
                Layer.succeed(SqlClient.SqlClient, sql),
              ),
            ),
          );
          expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
            "cannot use the table",
          );
        }
        for (const schema of ["main", "app"]) {
          expect(
            yield* sql`SELECT name FROM ${sql(schema)}.sqlite_master`,
          ).toEqual([]);
        }
      }),
  );

  // An application often has its client turn `camelCase` into `snake_case`.
  // The store's statements must not go through that.
  it.effect("uses its own names, whatever the client renames", () =>
    Effect.gen(function* () {
      const shout = (name: string) => name.toUpperCase();
      const sql = yield* SqliteClient.make({
        filename: ":memory:",
        transformQueryNames: shout,
        transformResultNames: shout,
      }).pipe(Effect.provide(Reactivity.layer));
      const { store } = yield* sqlStore
        .makeWithSweep({ table: "Keys" })
        .pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provide(SecureRandom.layerWebCrypto),
        );

      yield* store.complete(yield* claimed(store, "k"), response, retention);
      expect(yield* claim(store, "k")).toMatchObject({
        _tag: "Completed",
        response,
      });
      const tables = yield* sql.withoutTransforms()<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'`;
      expect(tables).toEqual([{ name: "Keys" }]);
    }),
  );

  it.effect("does not build on a database it does not support", () =>
    Effect.gen(function* () {
      const mysql = yield* SqlClient.make({
        acquirer: Effect.die(new Error("The test runs no statement")),
        compiler: Statement.makeCompiler({
          dialect: "mysql",
          placeholder: () => "?",
          onIdentifier: (value) => `\`${value}\``,
          onRecordUpdate: () => ["", []],
          onCustom: () => ["", []],
        }),
        driver: "test",
        spanAttributes: [],
      }).pipe(Effect.provide(Reactivity.layer));

      const exit = yield* Effect.exit(
        Layer.build(
          Layer.provide(
            IdempotencyStore.layerSql(),
            Layer.succeed(SqlClient.SqlClient, mysql),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
        "supports PostgreSQL and SQLite",
      );
    }),
  );
});
