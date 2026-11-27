import { Effect, Stream } from "effect";
import { type HttpServerRequest, Multipart } from "effect/http";

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
 */
export const make = (
  request: HttpServerRequest.HttpServerRequest,
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
        // A request made from this one keeps the body.
        case "modify":
          return (
            options: Parameters<
              HttpServerRequest.HttpServerRequest["modify"]
            >[0],
          ) => make(target.modify(options), body);
        default:
          // With the proxy as `this`, the original's `text`, `json` and
          // `urlParamsBody` read `arrayBuffer` above. A proxy hands values on
          // whatever their type, so `unknown` says no more than it knows.
          return Reflect.get(target, property, receiver) as unknown;
      }
    },
  });
};
