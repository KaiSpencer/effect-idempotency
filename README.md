# effect-idempotency

`Idempotency-Key` handling for [Effect](https://effect.website)'s `HttpApi`: a
server middleware that makes a retried request return the first response, and
a client middleware that sends the same key on every retry.

> **Status: in development.** The server middleware and an in-memory store
> work and are tested. The client middleware and the SQL and Redis stores are
> not written yet.

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

**What is stored.** A response with a status below `400` is stored whole, as
it is sent: status, headers, cookies and body. It is kept for `retention`, 24 hours by
default, counted from when the handler finished. After that the key is new.

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
- A change a handler registers to be made to its response later, as
  `HttpApiBuilder.securitySetCookie` does, is stored when the response is
  sent. If the client has gone by then, Effect never makes the change, and the
  replay is the response as the handler returned it. A cookie or header that a
  retry must always get belongs on the response the handler returns.
- A replay does not run the handler, so a permission check inside the handler
  is not repeated. Put checks that must hold on every request in a middleware
  that runs outside this one, as authentication does.
- `IdempotencyStore.layerMemory` lives in one process and is lost on restart.
  It has no size limit: every stored response stays in memory for the
  retention. It suits tests, development, and a small server that runs as one
  process.

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

A store implements three operations of the `IdempotencyStore` service: `claim`
a key, `complete` a claim with a response, and `release` a claim. `claim` must
be atomic. The comparing of requests and the choice of answer stay in the
middleware, so a store holds no HTTP logic.

The values a store handles are schemas. `IdempotencyStore.StoredResponse`
encodes to JSON with `Schema.toCodecJson`, the body in base64, and the key and
the fingerprint are branded strings, so a store cannot be handed a key the
middleware has not checked.

## Plan

1. **Persistent stores.** Layers for SQL and Redis, checked by the same
   contract tests as the memory store.
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
