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
 * Reading the body here does not take it from the handler: the request keeps
 * what it has read.
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

export const make = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
): Effect.fn.Return<Fingerprint, never, Digest.Digest> {
  const digest = yield* Digest.Digest;
  const body = yield* Effect.orDie(request.arrayBuffer);
  const hash = yield* digest.digestHex(Digest.sha256, new Uint8Array(body));
  return Fingerprint.make(
    `${request.method} ${pathAndQuery(request.originalUrl)} ${hash}`,
  );
});
