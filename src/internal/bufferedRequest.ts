import { Effect, Stream } from "effect";
import {
  HttpClientRequest,
  type HttpServerRequest,
  Multipart,
} from "effect/http";

/**
 * The request the handler sees once the middleware has read the body to
 * fingerprint it.
 *
 * A request caches its body when it is read as bytes, and `text`, `json` and
 * `urlParamsBody` read that cache. `stream` and `multipartStream` do not: they
 * read the body from the connection, which the middleware has already read to
 * the end. So an endpoint whose payload is a `Stream` or multipart would find
 * nothing there. This request answers those, and `arrayBuffer`, from the bytes
 * the middleware read, so every payload decodes as it would without the
 * middleware.
 *
 * It is a `Proxy` and not a class: everything else, including what a platform
 * adds of its own, such as Bun's `source`, is the original request's.
 *
 * A request made in memory from a client request, as `HttpApiTest` and
 * `HttpServerRequest.fromClientRequest` make, is returned as it is when its
 * body can be read again: none, bytes or a `FormData`. Its form data in
 * particular is parsed from the `FormData` itself, since read as bytes a form
 * is encoded with a boundary its headers do not name. A stream or a platform
 * body can be read once only, so that request is wrapped too.
 */
export const make = (
  request: HttpServerRequest.HttpServerRequest,
  body: ArrayBuffer,
): HttpServerRequest.HttpServerRequest =>
  readsAgain(request) ? request : replaying(request, request, body);

const readsAgain = (request: HttpServerRequest.HttpServerRequest): boolean => {
  if (!HttpClientRequest.isHttpClientRequest(request.source)) return false;
  const tag = request.source.body._tag;
  return tag === "Empty" || tag === "Uint8Array" || tag === "FormData";
};

/**
 * `request`, with its body read from `body`. `cached` is the request the
 * middleware read the body of, which keeps it in its cache.
 */
const replaying = (
  request: HttpServerRequest.HttpServerRequest,
  cached: HttpServerRequest.HttpServerRequest,
  body: ArrayBuffer,
): HttpServerRequest.HttpServerRequest => {
  const stream = (): Stream.Stream<Uint8Array> =>
    body.byteLength === 0 ? Stream.empty : Stream.succeed(new Uint8Array(body));
  const multipartStream = (): Stream.Stream<
    Multipart.Part,
    Multipart.MultipartError
  > =>
    Stream.pipeThroughChannel(stream(), Multipart.makeChannel(request.headers));
  // Persisting writes the files to disk, so it happens once per request, as
  // it does on the original.
  let multipart: HttpServerRequest.HttpServerRequest["multipart"] | undefined;

  return new Proxy(request, {
    get(target, property, receiver) {
      switch (property) {
        case "arrayBuffer":
          return Effect.succeed(body);
        case "stream":
          return stream();
        case "multipartStream":
          return multipartStream();
        case "multipart":
          multipart ??= Effect.runSync(
            Effect.cached(Multipart.toPersisted(multipartStream())),
          );
          return multipart;
        // These read the body through the cache of the request that was
        // read. A request made with `modify` starts with an empty cache of
        // its own, and would read a body that is used up.
        case "text":
        case "json":
        case "urlParamsBody":
          return Reflect.get(cached, property, cached) as unknown;
        // A request made from this one keeps the body.
        case "modify":
          return (
            options: Parameters<
              HttpServerRequest.HttpServerRequest["modify"]
            >[0],
          ) => replaying(target.modify(options), cached, body);
        default:
          // A proxy hands values on whatever their type, so `unknown` says no
          // more than it knows.
          return Reflect.get(target, property, receiver) as unknown;
      }
    },
  });
};
