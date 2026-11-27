import { Effect, Stream } from "effect";
import { HttpServerRequest } from "effect/http";
import * as BufferedRequest from "../../src/internal/bufferedRequest.ts";
import { describe, expect, it } from "../support/EffectTest.ts";

/**
 * A request whose body has been read to the end, as the middleware reads it,
 * and the request the handler is given in its place.
 */
const buffered = (
  body: string | ArrayBuffer,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const original = HttpServerRequest.fromWeb(
      new Request("http://localhost/payments", {
        method: "POST",
        body,
        headers: headers ?? {},
      }),
    );
    const bytes = yield* Effect.orDie(original.arrayBuffer);
    return { original, request: BufferedRequest.make(original, bytes) };
  });

const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Effect.orDie(Stream.mkString(Stream.decodeText(stream)));

describe("BufferedRequest", () => {
  it.effect("streams the body that was already read", () =>
    Effect.gen(function* () {
      const { original, request } = yield* buffered("one\ntwo\n");
      // The original's stream reads the connection, which is used up.
      expect((yield* Effect.exit(text(original.stream)))._tag).toBe("Failure");
      expect(yield* text(request.stream)).toBe("one\ntwo\n");
    }),
  );

  it.effect("streams the body again each time", () =>
    Effect.gen(function* () {
      const { request } = yield* buffered("body");
      expect(yield* text(request.stream)).toBe("body");
      expect(yield* text(request.stream)).toBe("body");
    }),
  );

  it.effect("streams nothing for an empty body", () =>
    Effect.gen(function* () {
      const { request } = yield* buffered("");
      expect(yield* Stream.runCollect(Stream.orDie(request.stream))).toEqual(
        [],
      );
    }),
  );

  it.effect("reads the body as bytes, text and JSON", () =>
    Effect.gen(function* () {
      const { request } = yield* buffered('{"amount":5}');
      expect(
        new TextDecoder().decode(yield* Effect.orDie(request.arrayBuffer)),
      ).toBe('{"amount":5}');
      expect(yield* Effect.orDie(request.text)).toBe('{"amount":5}');
      expect(yield* Effect.orDie(request.json)).toEqual({ amount: 5 });
    }),
  );

  it.effect("parses a multipart body", () =>
    Effect.gen(function* () {
      const form = new FormData();
      form.append("amount", "5");
      form.append("receipt", new Blob(["file contents"]), "receipt.txt");
      const encoded = new Request("http://localhost", {
        method: "POST",
        body: form,
      });
      // Read first: Bun drops the header of a form body once it is read.
      const contentType = encoded.headers.get("content-type") ?? "";
      const { request } = yield* buffered(
        yield* Effect.promise(() => encoded.arrayBuffer()),
        { "content-type": contentType },
      );

      const parts = yield* Effect.orDie(
        Stream.runCollect(request.multipartStream),
      );
      expect(parts.map((part) => `${part._tag}:${part.key}`)).toEqual([
        "Field:amount",
        "File:receipt",
      ]);
    }),
  );

  it.effect("keeps the body in a request made from it", () =>
    Effect.gen(function* () {
      const { request } = yield* buffered("body");
      const modified = request.modify({ url: "/elsewhere" });
      expect(modified.url).toBe("/elsewhere");
      expect(yield* text(modified.stream)).toBe("body");
      expect(yield* Effect.orDie(modified.text)).toBe("body");
    }),
  );

  it.effect("is the original request in every other respect", () =>
    Effect.gen(function* () {
      const { original, request } = yield* buffered("body", {
        "x-user": "alice",
      });
      expect(HttpServerRequest.TypeId in request).toBe(true);
      expect(request.method).toBe("POST");
      expect(request.originalUrl).toBe(original.originalUrl);
      expect(request.headers["x-user"]).toBe("alice");
      expect(request.source).toBe(original.source);
    }),
  );
});
