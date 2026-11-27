# effect-idempotency

## 0.0.2

### Patch Changes

- [#11](https://github.com/KaiSpencer/effect-idempotency/pull/11) [`b3f249e`](https://github.com/KaiSpencer/effect-idempotency/commit/b3f249e0d87bdb90d16b85ccbf3dd7500817c219) Thanks [@KaiSpencer](https://github.com/KaiSpencer)! - The guide moves to the documentation site, https://effect-idempotency.vercel.app, which the package's `homepage` now names. It has a page per module, and serves its pages as Markdown and through an MCP server for coding agents. The README keeps an introduction, a short example, and the sections on the four errors that each problem's `type` links to.

- [#6](https://github.com/KaiSpencer/effect-idempotency/pull/6) [`f6ab762`](https://github.com/KaiSpencer/effect-idempotency/commit/f6ab7625ba6a4f02175a76101201b55a95a47b30) Thanks [@KaiSpencer](https://github.com/KaiSpencer)! - Add the server middleware. `Idempotency.Service` declares an `HttpApiMiddleware` with the idempotency errors, and `Idempotency.layer` provides it with a scope, a retention and a lock expiry. A retry with the same key and the same request gets the first response, with `Idempotent-Replayed: true`, if its status was below 400 and it is within the retention (24 hours by default). A response whose body is a stream or a file is sent but not stored, so a retry runs the handler again. A different request with the key gets `422`. A retry while the first request runs gets `409` until the lock expiry (5 minutes by default); after it, the retry runs the handler alongside the first request.
  
  Add `IdempotencyStore`, the service a store implements, `IdempotencyStore.layerMemory`, and the `StoredResponse` and `Fingerprint` schemas a store handles.
  
  Add `IdempotencyError`: `IdempotencyKeyMissing`, `IdempotencyKeyInvalid`, `IdempotencyKeyMismatch` and `IdempotencyKeyInProgress`, each an `application/problem+json` problem.
  
  Add `IdempotencyKey.IdempotencyKey`, a branded schema for a checked key, and `IdempotencyKey.FromHeader`, a codec between the key and its header value, for the `headers` of an endpoint. `IdempotencyKey.parse` now returns the branded key and rejects a key longer than 255 characters.

- [#8](https://github.com/KaiSpencer/effect-idempotency/pull/8) [`901354f`](https://github.com/KaiSpencer/effect-idempotency/commit/901354f76fe61f82ca86f3e138ce6eb9fab01295) Thanks [@KaiSpencer](https://github.com/KaiSpencer)! - Add `IdempotencyStore.layerSql`, a store in PostgreSQL or SQLite through the `SqlClient` the application already provides. Servers that share the database share the keys, and a stored response survives a restart.
  
  The layer creates its table, `effect_idempotency` unless `layerSql({ table })` names another, and an index. A key is claimed with one statement, so no transaction is needed and two servers cannot both get a key. For as long as the layer is built it deletes, every five minutes, the responses past their retention and the claims whose lock has been expired for 24 hours, which is what a dead process leaves behind.
  
  A claim whose response is past its retention can no longer store a response, in either store. Before, the memory store would store it again if it had not yet removed the old one.

## 0.0.1

### Patch Changes

- [`586f5d4`](https://github.com/KaiSpencer/effect-idempotency/commit/586f5d4c70d5c0a01f95602233aca7962fec6113) Thanks [@KaiSpencer](https://github.com/KaiSpencer)! - Add `IdempotencyKey.parse`, which reads the key from an `Idempotency-Key` header value, quoted or bare.
