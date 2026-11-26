# effect-idempotency

`Idempotency-Key` handling for [Effect](https://effect.website)'s `HttpApi`: a
server middleware that makes a retried request return the first response, and
a client middleware that sends the same key on every retry.

> **Status: in development.** Nothing is published yet beyond this README.
> `0.0.0` on npm reserves the name. The API below is the plan, not a release.

## Why

A client that times out on `POST /payments` cannot tell whether the payment
happened. If it retries, it may pay twice. An idempotency key fixes that: the
client sends one key per operation, and the server runs the operation once per
key and replays the stored response to every retry.

Effect has no HTTP idempotency support today. The generic TypeScript
middlewares are built for Express or Hono handlers and know nothing of typed
errors, layers, `SqlClient` transactions, or the generated `HttpApiClient`.

## Plan

1. **Server middleware and store.** An `HttpApiMiddleware` configured per
   endpoint (required or optional key, expiry, fingerprint fields), backed by
   an `IdempotencyStore` service with an atomic claim. Layers for memory, SQL,
   and Redis. The errors are schemas, so they appear in OpenAPI and in the
   client's error channel.
2. **Client middleware.** The generated client creates one key per call and
   keeps it across `Effect.retry`. A retry that arrives while the first request
   is still running is treated as retriable.
3. **Transactional mode.** The key's completion is written in the same
   `SqlClient` transaction as the handler's own writes, so a crash cannot
   leave the side effect done and the key unrecorded.
4. **Later.** A bridge to `effect/workflow` so a long handler becomes a
   durable run a retry rejoins, the same store for `Rpc`, and a fetch-style
   wrapper for non-Effect servers.

## Wire format

The header and status codes follow the IETF draft
[The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header):

| Case | Response |
|---|---|
| Key required and missing | `400` |
| Key reused with a different request | `422` |
| Retry while the first request is still running | `409` |
| Retry after the first request finished | the stored response |

Errors are `application/problem+json`. The draft leaves the hard parts open
(crash recovery, key scoping, which responses are stored), so those follow
Stripe's documented behavior. The key is accepted quoted, as the draft's
structured-field syntax requires, and bare, as most clients send it.

## License

MIT
