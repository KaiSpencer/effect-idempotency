# effect-idempotency

`Idempotency-Key` handling for [Effect](https://effect.website)'s `HttpApi`: a
server middleware that makes a retried request return the first response, and
a client middleware that sends the same key on every retry.

> **Status: in development.** The server middleware works and is tested, with
> a store in memory and a store in PostgreSQL or SQLite. The client middleware
> and the Redis store are not written yet.

**[Read the documentation](https://effect-idempotency.vercel.app)**

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
```

On the server, provide the middleware with a scope and a store:

```ts
const PaymentIdempotencyLive = Idempotency.layer(PaymentIdempotency, {
  scope: Effect.map(CurrentUser, (user) => user.id),
}).pipe(Layer.provide(IdempotencyStore.layerMemory));
```

A retry with the same key and the same request now gets the first response
back, with `Idempotent-Replayed: true`.
[Getting started](https://effect-idempotency.vercel.app/getting-started) has
the whole program: the API, the server and a client that retries.

## Documentation

- [Getting started](https://effect-idempotency.vercel.app/getting-started):
  add a key to one endpoint.
- [Behaviour](https://effect-idempotency.vercel.app/behaviour/requests): how
  each request is answered, what is stored, and what happens when a client or
  a process goes away.
- [Stores](https://effect-idempotency.vercel.app/stores): memory, PostgreSQL
  or SQLite, or a store of your own.
- [Reference](https://effect-idempotency.vercel.app/reference/idempotency):
  every export.
- [Roadmap](https://effect-idempotency.vercel.app/roadmap): what comes next.

The site is written for coding agents too: it serves
[`llms.txt`](https://effect-idempotency.vercel.app/llms.txt), every page as
Markdown, and an MCP server. See
[AI agents](https://effect-idempotency.vercel.app/agents).

## Errors

Errors are `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)).
Each is a schema in `IdempotencyError`, so it appears in OpenAPI and in a
generated client's error channel. The `type` of each problem is the link to
its heading below, so these headings do not change.
[Errors](https://effect-idempotency.vercel.app/errors) says how to fix each.

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

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
