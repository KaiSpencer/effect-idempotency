import { Cookies, HttpServerResponse } from "effect/http";
import type { StoredResponse } from "../IdempotencyStore.ts";

/**
 * How the middleware can keep a response:
 *
 * - `Bytes`: the body is in memory, or there is none, and can be stored now.
 * - `Stream`: the body is a stream, which is stored once it has been read to
 *   the end.
 * - `None`: the body is a file, form data or a platform value, and is not
 *   stored.
 */
export type Storable =
  | { readonly _tag: "Bytes"; readonly body: Uint8Array | undefined }
  | { readonly _tag: "Stream" }
  | { readonly _tag: "None" };

export const storable = (
  response: HttpServerResponse.HttpServerResponse,
): Storable => {
  const body = response.body;
  switch (body._tag) {
    case "Empty":
      return { _tag: "Bytes", body: undefined };
    case "Uint8Array":
      return { _tag: "Bytes", body: body.body };
    case "Stream":
      return { _tag: "Stream" };
    case "FormData":
    case "Raw":
      return { _tag: "None" };
  }
};

/**
 * Copies a response into the form the store keeps, with `body` as its body:
 * the bytes of a body in memory, or of a stream once it has ended.
 */
export const make = (
  response: HttpServerResponse.HttpServerResponse,
  body: Uint8Array | undefined,
): StoredResponse => ({
  status: response.status,
  statusText: response.statusText,
  headers: { ...response.headers },
  cookies: Cookies.toSetCookieHeaders(response.cookies),
  // A copy: the handler still holds the original and could write to it.
  body: body === undefined ? undefined : new Uint8Array(body),
});

/**
 * Copies a response whose body is in memory into the form the store keeps.
 * Returns `undefined` for any other response.
 */
export const fromResponse = (
  response: HttpServerResponse.HttpServerResponse,
): StoredResponse | undefined => {
  const kind = storable(response);
  return kind._tag === "Bytes" ? make(response, kind.body) : undefined;
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
    : // A copy, so that nothing done to one replay reaches the next.
      HttpServerResponse.uint8Array(new Uint8Array(stored.body), options);
};
