---
"effect-idempotency": minor
---

Support streamed bodies ([#3](https://github.com/KaiSpencer/effect-idempotency/issues/3)).

A streamed response is now stored once the stream has ended, and replayed to every retry. Until it ends a retry gets `409`. A client that leaves part way does not stop the stream: the middleware reads it to the end and stores it for the retry. A stream that fails releases the key. Before, a streamed response was sent but not stored, and its key released.

An endpoint whose payload is a `Stream` (`HttpApiSchema.StreamUint8Array`, `HttpApiSchema.StreamNdjson`) or multipart (`HttpApiSchema.asMultipart`, `HttpApiSchema.asMultipartStream`) now works behind the middleware. The middleware reads the body whole to fingerprint it, and the handler reads it from memory. Before, the handler found the body already read. `HttpIncomingMessage.MaxBodySize` bounds the body, and a larger one is answered `413` before the key is claimed.

Add `Idempotency.FingerprintBody`, an endpoint annotation. Set to `false`, the middleware leaves the body for the handler to stream, and compares the `Content-Digest` and `Repr-Digest` headers (RFC 9530) in its place.

Add the `maxStoredBytes` option, 1 MiB by default: a larger response is sent whole but not stored, and its key is released. Before, a response in memory was stored whatever its size. Raise the limit for an endpoint whose responses are larger.
