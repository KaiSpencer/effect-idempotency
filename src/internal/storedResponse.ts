import { Cookies, HttpServerResponse } from "effect/http";
import type { StoredResponse } from "../IdempotencyStore.ts";

/**
 * Whether a response can be stored: its body is already bytes in memory, and
 * not a stream, a file or form data.
 */
export const canStore = (
  response: HttpServerResponse.HttpServerResponse,
): boolean =>
  response.body._tag === "Empty" || response.body._tag === "Uint8Array";

/**
 * Copies a response into the form the store keeps. Returns `undefined` for a
 * response that {@link canStore} refuses.
 */
export const fromResponse = (
  response: HttpServerResponse.HttpServerResponse,
): StoredResponse | undefined => {
  const body = response.body;
  if (body._tag !== "Empty" && body._tag !== "Uint8Array") return undefined;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: { ...response.headers },
    cookies: Cookies.toSetCookieHeaders(response.cookies),
    // A copy: the handler still holds the original and could write to it.
    body: body._tag === "Empty" ? undefined : new Uint8Array(body.body),
  };
};

/** Rebuilds the response a client first received. */
export const toResponse = (
  stored: StoredResponse,
): HttpServerResponse.HttpServerResponse => {
  const options = {
    status: stored.status,
    statusText: stored.statusText,
    headers: stored.headers,
    cookies: Cookies.fromSetCookie(stored.cookies),
  };
  return stored.body === undefined
    ? HttpServerResponse.empty(options)
    : HttpServerResponse.uint8Array(stored.body, options);
};
