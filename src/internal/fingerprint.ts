import { Effect } from "effect";
import { Digest } from "effect/crypto";
import type { HttpServerRequest } from "effect/http";
import { Fingerprint } from "../IdempotencyStore.ts";

/**
 * What makes two requests the same request: the method, the path with its
 * query string, and the SHA-256 of the body's bytes.
 *
 * The body is compared byte for byte. The same JSON with its keys in another
 * order is a different request, which a retry never produces because it sends
 * the bytes it sent before.
 *
 * An endpoint can leave the body out, so that its body is never read ahead
 * of the handler. Its requests are then the same when their method, path,
 * query string and digest headers are: see {@link digestHeaders}.
 */
const origin = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i;

/**
 * The path and query of the URL the client asked for. `originalUrl` is used
 * and not `url`, which a router that mounts the API under a prefix rewrites.
 * Some servers put the scheme and host in it, and those are dropped: a retry
 * through another host name is still the same request.
 */
const pathAndQuery = (originalUrl: string): string =>
  originalUrl.replace(origin, "");

/**
 * The headers that stand in for a body the fingerprint leaves out. They are
 * the digests of RFC 9530, which a client computes over the bytes it sends,
 * so two requests that carry the same one carry the same body. A request
 * without them is told apart by its method, path and query only.
 *
 * `content-type` and `content-length` are not among them: a client that
 * builds a multipart body again for a retry draws a new boundary, which
 * changes both, and would be refused as a different request.
 */
export const digestHeaders = ["content-digest", "repr-digest"] as const;

/**
 * Makes the fingerprint of `request`. With `body`, the bytes of the body are
 * part of it. Without, the request's {@link digestHeaders} are, and the body
 * is not read.
 */
export const make = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  body: ArrayBuffer | undefined,
): Effect.fn.Return<Fingerprint, never, Digest.Digest> {
  const digest = yield* Digest.Digest;
  const target = `${request.method} ${pathAndQuery(request.originalUrl)}`;
  if (body !== undefined) {
    const hash = yield* digest.digestHex(Digest.sha256, new Uint8Array(body));
    return Fingerprint.make(`${target} ${hash}`);
  }
  // The values are kept as they are, in JSON so that none can run into the
  // next. `headers` marks the kind, so this can never equal the fingerprint
  // of a body, which is a hash.
  const headers = JSON.stringify(
    digestHeaders.map((name) => request.headers[name] ?? null),
  );
  return Fingerprint.make(`${target} headers ${headers}`);
});
