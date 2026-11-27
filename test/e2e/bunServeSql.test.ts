/**
 * What a client sees when the keys are in a database. First every scenario of
 * `scenarios.ts`, on `IdempotencyStore.layerSql` as an application provides
 * it. Then what only a shared store makes possible: a retry that reaches
 * another server than the first request did, or a server started later.
 */
import { Context, Effect, Fiber, Layer, type Scope } from "effect";
import { HttpClient } from "effect/http";
import { describe, expect, it } from "../support/EffectTest.ts";
import {
  type Backend,
  backends,
  layerSqlOn,
  reportMissingPostgres,
} from "../support/sqlBackends.ts";
import { serve } from "./bunServer.ts";
import {
  charges,
  chargesReach,
  create,
  hold,
  idempotencyScenarios,
  resume,
} from "./scenarios.ts";

/** Sends the request to the server the client points at. */
const on =
  (client: HttpClient.HttpClient) =>
  <A, E>(
    request: Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>,
  ): Effect.Effect<A, E, Scope.Scope> =>
    Effect.provideService(request, HttpClient.HttpClient, client);

/**
 * A database and a way to start a server on it. Every server has a client of
 * the database, a store and a ledger of its own, as two machines would.
 */
const cluster = (backend: Backend) =>
  Effect.map(backend.database, (database) => ({
    start: Effect.map(
      Layer.build(serve(layerSqlOn(backend, database))),
      (context) => on(Context.get(context, HttpClient.HttpClient)),
    ),
  }));

reportMissingPostgres();

for (const backend of backends) {
  idempotencyScenarios(
    `Bun.serve with layerSql on ${backend.name}`,
    serve(layerSqlOn(backend)),
  );

  describe(`two servers with layerSql on ${backend.name}`, () => {
    const test = <A, E>(
      label: string,
      self: () => Effect.Effect<A, E, Scope.Scope>,
    ): void => {
      it.live(label, self, backend.timeout);
    };

    test("replays to a retry that reaches the other server", () =>
      Effect.gen(function* () {
        const { start } = yield* cluster(backend);
        const a = yield* start;
        const b = yield* start;

        const first = yield* a(create(5));
        const retry = yield* b(create(5));

        expect(first.status).toBe(200);
        expect(retry.status).toBe(200);
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(retry.headers["content-type"]).toBe(
          first.headers["content-type"],
        );
        expect(yield* retry.arrayBuffer).toEqual(yield* first.arrayBuffer);
        expect(yield* a(charges)).toBe(1);
        expect(yield* b(charges)).toBe(0);
      }));

    test("answers 409 on one server while the request runs on the other, then replays it", () =>
      Effect.gen(function* () {
        const { start } = yield* cluster(backend);
        const a = yield* start;
        const b = yield* start;
        yield* a(hold);
        const first = yield* Effect.forkChild(a(create(5)));
        yield* a(chargesReach(1));

        expect((yield* b(create(5))).status).toBe(409);

        yield* a(resume);
        const payment = yield* (yield* Fiber.join(first)).json;
        const retry = yield* b(create(5));
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* retry.json).toEqual(payment);
        expect(yield* b(charges)).toBe(0);
      }));

    test("answers 422 on one server to a key the other saw with a different request", () =>
      Effect.gen(function* () {
        const { start } = yield* cluster(backend);
        const a = yield* start;
        const b = yield* start;

        yield* a(create(5));
        expect((yield* b(create(6))).status).toBe(422);
        expect(yield* b(charges)).toBe(0);
      }));

    test("runs the handler once for many concurrent requests spread over both", () =>
      Effect.gen(function* () {
        const { start } = yield* cluster(backend);
        const a = yield* start;
        const b = yield* start;

        const responses = yield* Effect.all(
          Array.from({ length: 20 }, (_, index) =>
            (index % 2 === 0 ? a : b)(create(5)),
          ),
          { concurrency: "unbounded" },
        );

        const replayed = responses.filter(
          (response) => response.headers["idempotent-replayed"] === "true",
        );
        const ran = responses.filter(
          (response) => response.status === 200 && !replayed.includes(response),
        );
        const refused = responses.filter((response) => response.status === 409);
        expect(ran).toHaveLength(1);
        expect(replayed.length + refused.length).toBe(19);
        expect((yield* a(charges)) + (yield* b(charges))).toBe(1);
      }));

    test("lets the other server run a request whose first attempt failed", () =>
      Effect.gen(function* () {
        const { start } = yield* cluster(backend);
        const a = yield* start;
        const b = yield* start;

        expect((yield* a(create(-1))).status).toBe(402);
        const retry = yield* b(create(-1));
        expect(retry.status).toBe(402);
        expect(retry.headers["idempotent-replayed"]).toBeUndefined();
        expect(yield* b(charges)).toBe(1);
      }));

    test("keeps the same key of two users apart on both servers", () =>
      Effect.gen(function* () {
        const { start } = yield* cluster(backend);
        const a = yield* start;
        const b = yield* start;

        yield* a(create(5, { user: "alice" }));
        const other = yield* b(create(5, { user: "bob" }));
        expect(other.headers["idempotent-replayed"]).toBeUndefined();
        expect(yield* b(charges)).toBe(1);
      }));

    test("replays after a restart: to a server started when the first had stopped", () =>
      Effect.gen(function* () {
        const { start } = yield* cluster(backend);
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const a = yield* start;
            return yield* (yield* a(create(5))).json;
          }),
        );

        const b = yield* start;
        const retry = yield* b(create(5));
        expect(retry.headers["idempotent-replayed"]).toBe("true");
        expect(yield* retry.json).toEqual(first);
        expect(yield* b(charges)).toBe(0);
      }));
  });
}
