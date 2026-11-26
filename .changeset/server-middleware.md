---
"effect-idempotency": patch
---

Add the server middleware. `Idempotency.Service` declares an `HttpApiMiddleware` with the idempotency errors, and `Idempotency.layer` provides it with a scope, a retention and a lock expiry. A retry with the same key and the same request gets the first response with `Idempotent-Replayed: true`; a different request gets `422` and a retry during the first request gets `409`.

Add `IdempotencyStore`, the service a store implements, `IdempotencyStore.layerMemory`, and the `StoredResponse` and `Fingerprint` schemas a store handles.

Add `IdempotencyError`: `IdempotencyKeyMissing`, `IdempotencyKeyInvalid`, `IdempotencyKeyMismatch` and `IdempotencyKeyInProgress`, each an `application/problem+json` problem.

Add `IdempotencyKey.IdempotencyKey`, a branded schema for a checked key, and `IdempotencyKey.FromHeader`, a codec between the key and its header value, for the `headers` of an endpoint. `IdempotencyKey.parse` now returns the branded key and rejects a key longer than 255 characters.
