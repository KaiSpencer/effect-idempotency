import { Cookies, HttpServerResponse } from "effect/http";
import type { StoredResponse } from "../IdempotencyStore.ts";

/**
 * Copies a response into the form the store keeps. Returns `undefined` for a
 * body that is not already bytes in memory: a stream, a file, form data.
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
    body: body._tag === "Empty" ? undefined : body.body,
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
