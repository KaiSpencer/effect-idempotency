---
"effect-idempotency": patch
---

Add the server middleware. `Idempotency.Service` declares an `HttpApiMiddleware` with the idempotency errors, and `Idempotency.layer` provides it with a scope, a retention and a lock expiry. A retry with the same key and the same request gets the first response, with `Idempotent-Replayed: true`, if its status was below 400 and it is within the retention (24 hours by default). A response whose body is a stream or a file is sent but not stored, so a retry runs the handler again. A different request with the key gets `422`. A retry while the first request runs gets `409` until the lock expiry (5 minutes by default); after it, the retry runs the handler alongside the first request.

Add `IdempotencyStore`, the service a store implements, `IdempotencyStore.layerMemory`, and the `StoredResponse` and `Fingerprint` schemas a store handles.

Add `IdempotencyError`: `IdempotencyKeyMissing`, `IdempotencyKeyInvalid`, `IdempotencyKeyMismatch` and `IdempotencyKeyInProgress`, each an `application/problem+json` problem.

Add `IdempotencyKey.IdempotencyKey`, a branded schema for a checked key, and `IdempotencyKey.FromHeader`, a codec between the key and its header value, for the `headers` of an endpoint. `IdempotencyKey.parse` now returns the branded key and rejects a key longer than 255 characters.
