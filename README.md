# effect-idempotency

`Idempotency-Key` handling for [Effect](https://effect.website)'s `HttpApi`: a
server middleware that makes a retried request return the first response, and
a client middleware that sends the same key on every retry.

> **Status: in development.** The server middleware works and is tested, with
> a store in memory and a store in PostgreSQL or SQLite. The client middleware
> and the Redis store are not written yet.

## Why

A client that times out on `POST /payments` cannot tell whether the payment
happened. If it retries, it may pay twice. An idempotency key fixes that: the
client sends one key per operation, and the server runs the operation once per
key and replays the stored response to every retry.

Effect has no HTTP idempotency support today. The generic TypeScript
middlewares are built for Express or Hono handlers and know nothing of typed
errors, layers, `SqlClient` transactions, or the generated `HttpApiClient`.

## Usage

Declare a middleware class next to the API and add it to the endpoints that
must not run twice:

```ts
import { Effect, Layer, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
import {
  Idempotency,
  IdempotencyKey,
  IdempotencyStore,
} from "effect-idempotency";

class PaymentIdempotency extends Idempotency.Service<
  PaymentIdempotency,
  { requires: CurrentUser }
>()("app/PaymentIdempotency") {}

const Payments = HttpApiGroup.make("payments")
  .add(
    HttpApiEndpoint.post("create", "/payments", {
      headers: Schema.Struct({ "idempotency-key": IdempotencyKey.FromHeader }),
      payload: Schema.Struct({ amount: Schema.Number }),
      success: Payment,
    }),
  )
  .middleware(PaymentIdempotency)
  // Added after, so it runs first and the user is known.
  .middleware(Authentication);

const Api = HttpApi.make("api").add(Payments);
```

On the server, provide the middleware with a scope and a store:

```ts
const PaymentIdempotencyLive = Idempotency.layer(PaymentIdempotency, {
  scope: Effect.map(CurrentUser, (user) => user.id),
}).pipe(Layer.provide(IdempotencyStore.layerMemory));

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(PaymentsHandlers),
  Layer.provide([PaymentIdempotencyLive, AuthenticationLive]),
);
```

Declaring the header with `IdempotencyKey.FromHeader` puts it in the OpenAPI
document and makes a generated client ask for it. The client takes an
`IdempotencyKey`, a branded string that `IdempotencyKey.IdempotencyKey.make`
checks, and sends it in the quoted form:

```ts
const pay = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Api);
  const key = IdempotencyKey.IdempotencyKey.make(crypto.randomUUID());
  return yield* client.payments.create({
    headers: { "idempotency-key": key },
    payload: { amount: 5 },
  });
});
```

`requires` names the services the scope reads. Leave it out when the scope
reads none.

`layerMemory` keeps the keys in the process. To keep them in the database the
application already uses, provide `layerSql` with its `SqlClient`:

```ts
import { PgClient } from "@effect/sql-pg";

const PaymentIdempotencyLive = Idempotency.layer(PaymentIdempotency, {
  scope: Effect.map(CurrentUser, (user) => user.id),
}).pipe(
  Layer.provide(IdempotencyStore.layerSql()),
  Layer.provide(PgClient.layer({ url })),
);
```

See [Stores](#stores) for what it does to the database.

## Behaviour

The header and status codes follow the IETF draft
[The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header).
The draft leaves the hard parts open, so those follow Stripe's documented
behaviour where Stripe documents one.

| Request                                    | Answer                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| No key                                     | `400`                                                 |
| A key that is not valid                    | `400`                                                 |
| A new key                                  | The handler runs                                      |
| A key used before with a different request | `422`                                                 |
| A key whose first request is still running | `409`                                                 |
| A key whose first request succeeded        | The stored response, with `Idempotent-Replayed: true` |
| A key whose first request did not succeed  | The handler runs again                                |

**The key.** The header value is accepted quoted, as the draft's
structured-field syntax requires, and bare, as most clients send it. Both give
the same key. A key is printable ASCII and at most 255 characters. A bare key
cannot contain a comma: two `Idempotency-Key` headers arrive joined by one, and
are refused. Quote a key that has one.

**Scope.** A key is unique within the scope the `scope` option returns for the
request. With the caller's id as the scope, two callers that send the same key
never see each other's responses. The option is required so that sharing keys
between all callers is a choice and not a default. With a constant scope, such
as `Effect.succeed("public")`, whoever sends a key and request that were used
before gets the stored response, cookies included.

**The same request.** Two requests are the same when their method, path, query
string and body bytes are the same. The body is compared byte for byte: the
same JSON with different whitespace is a different request. A retry sends the
bytes it sent before, so this only rejects a client that reuses a key.

**What is stored.** A response with a status below `400` is stored whole:
status, headers, cookies and body. A change the handler registers to be made
to its response later, as `HttpApiBuilder.securitySetCookie` does, is stored
with it. It is kept for `retention`, 24 hours by
default, counted from when the handler finished. After that the key is new.

The response is stored when the handler returns, and stored again once such a
change has been made, just before it is sent. Until that second write has
succeeded, a retry is answered with the response as the handler returned it,
without the change. How long that is depends on what the request still does
after its handler, and on one write to the store. Unless a middleware or
another such change waits on something, it is a few milliseconds with a
database, and the retry it concerns was sent while the first request was
still being answered. If the second write fails, it is logged, and the
response without the change stays stored for its retention and is what every
retry gets.

**What is not stored.** Nothing is stored and the key is released when the
handler fails with one of its errors, dies, or answers `400` or above, and
when the request is refused before the handler, as one that fails validation
or has an unsupported content type is. The next request with the key runs the
handler again. A handler that fails must therefore leave nothing behind, or
leave only what a second run can repeat.

**A client that disconnects.** Once a request has claimed its key the
middleware does not let it be interrupted, so a disconnect does not stop the
handler. A client that timed out gets `409` while the handler is still running
and the stored response after. Without this, the disconnect would stop the
handler part way and the retry would run its side effect a second time.

The same holds at shutdown: the server cannot interrupt the request, and one
that waits for requests in flight waits for these until their handlers finish.
Give a handler that can hang its own `Effect.timeout`, which still works.

**A process that dies.** A request holds its key for `lockExpiry`, 5 minutes by
default. If the process dies mid-request, another request can take the key
after that and run the handler again. Set `lockExpiry` longer than the slowest
handler: a handler that outlives it still stores its response, but a retry
that arrives in the meantime takes the key and runs alongside it. Until the
transactional mode below exists, a crash between the side effect and the
stored response means the side effect can happen twice.

**A store that fails.** If the key cannot be claimed, the request answers `500`
and the handler does not run. If the response cannot be stored, it is still
sent, and the key stays claimed until `lockExpiry`.

**Order.** Add the idempotency middleware before the authentication
middleware, so that authentication runs first: an unauthenticated request then
never reaches the store.

### Limits

- A response whose body is not bytes in memory, such as a stream, a file or
  form data, is sent but not stored, so a retry runs the handler again. A
  request whose payload is a stream or a multipart upload is not supported.
  See [#3](https://github.com/KaiSpencer/effect-idempotency/issues/3).
- A replay does not run the handler, so a permission check inside the handler
  is not repeated. Put checks that must hold on every request in a middleware
  that runs outside this one, as authentication does.
- `IdempotencyStore.layerMemory` lives in one process and is lost on restart.
  It has no size limit: every stored response stays in memory for the
  retention. It suits tests, development, and a small server that runs as one
  process.
- `IdempotencyStore.layerSql` has limits of its own, listed under
  [Stores](#stores).

## Errors

Errors are `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)).
Each is a schema in `IdempotencyError`, so it appears in OpenAPI and in a
generated client's error channel. The `type` of each problem is the link to
its heading below.

### Idempotency key missing

`400`, `IdempotencyKeyMissing`. The request has no `Idempotency-Key` header.

### Idempotency key invalid

`400`, `IdempotencyKeyInvalid`. The header is empty, longer than 255
characters, outside printable ASCII, or a quoted string that is not well
formed.

### Idempotency key mismatch

`422`, `IdempotencyKeyMismatch`. The key was first used with a different
request. Send a new key for a new request.

### Idempotency key in progress

`409`, `IdempotencyKeyInProgress`. The first request with this key is still
running. Retry after a short wait.

## Stores

| Layer                          | Keeps the keys in                         | Shared between servers | Survives a restart |
| ------------------------------ | ----------------------------------------- | ---------------------- | ------------------ |
| `IdempotencyStore.layerMemory` | The process                               | No                     | No                 |
| `IdempotencyStore.layerSql()`  | PostgreSQL or SQLite, through `SqlClient` | Yes                    | Yes                |

### SQL

`layerSql` needs the `SqlClient` of a PostgreSQL or SQLite database, from any
of Effect's clients for them. On another database the layer fails to build.
SQLite must be 3.35 or later, the first with `RETURNING`: on an older one the
layer builds and every claim fails.

**The table.** The layer creates one table and one index when it is built, if
they do not exist, so the database user needs the right to create them. Pass
`layerSql({ table: "..." })` for another name than `effect_idempotency`: one
name of at most 48 bytes, without a dot, so not a table in another schema. The
layer fails to build on any other name.

```sql
CREATE TABLE effect_idempotency (
  scope           TEXT   NOT NULL,
  idempotency_key TEXT   NOT NULL,
  fingerprint     TEXT   NOT NULL,
  token           TEXT   NOT NULL, -- a new UUID for every claim
  expires_at      BIGINT NOT NULL, -- milliseconds since the epoch
  response        TEXT,            -- the response as JSON, null while the request runs
  PRIMARY KEY (scope, idempotency_key)
);
CREATE INDEX effect_idempotency_expires_at_idx ON effect_idempotency (expires_at);
```

`expires_at` is when the lock expires while `response` is null, and when the
retention ends after. The response is the JSON of
`IdempotencyStore.StoredResponse`, its body in base64, so a stored body takes
a third more room than it has bytes.

**Claiming a key** is one statement, an insert that takes over the row if it
has expired, so it needs no transaction and two servers cannot both get a
key. A request that does not get the key, because it is answered `409`, `422`
or with the stored response, rewrites the row unchanged to read it.

**Old rows.** For as long as the layer is built it deletes, every five
minutes and in batches of 1000, the responses whose retention is over. A
claim that never finished, which is what a process that died leaves behind, is
deleted once its lock has been expired for 24 hours. Until then the request
that made it can still store its response, if nobody has taken the key.

**Clocks.** Times come from the `Clock` of each server, not from the
database. One server writes when a key expires and another may be the one to
read it, so two servers whose clocks differ disagree by that much about when a
lock has expired and when a retention is over: a response can be gone that
much early. Keep the difference a small part of `lockExpiry` and of
`retention`. The lock is counted from when the request asks for the key, so
the time it waits for a database connection is taken from `lockExpiry` too.

**Transactions.** The store uses the connection the request is on. A claim
made inside a transaction is invisible to other requests until it commits,
and gone if it rolls back, so a middleware that wraps the request in a
transaction must run inside the idempotency middleware, not around it.

**Limits.**

- MySQL and SQL Server are not supported.
- On PostgreSQL a scope cannot hold a NUL character. The claim fails, the
  request answers `500` and the handler does not run.
- If the database is down, so is every endpoint that carries the middleware:
  see [A store that fails](#behaviour).

### Writing a store

A store implements three operations of the `IdempotencyStore` service: `claim`
a key, `complete` a claim with a response, and `release` a claim. `claim` must
be atomic. The comparing of requests and the choice of answer stay in the
middleware, so a store holds no HTTP logic.

The values a store handles are schemas. `IdempotencyStore.StoredResponse`
encodes to JSON with `Schema.toCodecJson`, the body in base64, and the key and
the fingerprint are branded strings, so a store cannot be handed a key the
middleware has not checked.

## Plan

1. **More stores.** A layer for Redis, and MySQL in the SQL store, checked by
   the same contract tests as the stores there are.
2. **Client middleware.** The generated client creates one key per call and
   keeps it across `Effect.retry`. A `409` is treated as retriable.
3. **Per-endpoint options.** An optional key, and the request fields that make
   up the fingerprint.
4. **Transactional mode.** The key's completion is written in the same
   `SqlClient` transaction as the handler's own writes, so a crash cannot
   leave the side effect done and the key unrecorded.
5. **Later.** A bridge to `effect/workflow` so a long handler becomes a
   durable run a retry rejoins, the same store for `Rpc`, and a fetch-style
   wrapper for non-Effect servers.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
