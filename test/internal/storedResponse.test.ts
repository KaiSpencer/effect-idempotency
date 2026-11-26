import { Effect, Stream } from "effect";
import { Cookies, HttpServerResponse } from "effect/http";
import * as StoredResponse from "../../src/internal/storedResponse.ts";
import { describe, expect, it, test } from "../support/EffectTest.ts";

const roundTrip = (response: HttpServerResponse.HttpServerResponse) => {
  const stored = StoredResponse.fromResponse(response);
  if (stored === undefined) throw new Error("The response was not stored");
  return HttpServerResponse.toWeb(StoredResponse.toResponse(stored));
};

describe("StoredResponse", () => {
  test("restores the status, headers and body of a JSON response", async () => {
    const original = HttpServerResponse.jsonUnsafe(
      { id: "pay_1" },
      { status: 201, headers: { location: "/payments/pay_1" } },
    );
    const restored = roundTrip(original);

    expect(restored.status).toBe(201);
    expect(restored.headers.get("content-type")).toBe("application/json");
    expect(restored.headers.get("location")).toBe("/payments/pay_1");
    expect(await restored.text()).toBe(
      await HttpServerResponse.toWeb(original).text(),
    );
  });

  test("restores a response without a body", async () => {
    const restored = roundTrip(
      HttpServerResponse.empty({ status: 204, statusText: "Nothing To Say" }),
    );

    expect(restored.status).toBe(204);
    expect(restored.statusText).toBe("Nothing To Say");
    expect(await restored.text()).toBe("");
  });

  test("keeps its own copy of the body", () => {
    const bytes = new TextEncoder().encode("first");
    const stored = StoredResponse.fromResponse(
      HttpServerResponse.uint8Array(bytes),
    );
    bytes.fill(0);

    expect(new TextDecoder().decode(stored?.body)).toBe("first");
  });

  test("restores cookies", () => {
    const restored = roundTrip(
      HttpServerResponse.text("ok", {
        cookies: Cookies.fromSetCookie([
          "session=abc; Path=/; HttpOnly",
          "theme=dark",
        ]),
      }),
    );

    expect(restored.headers.getSetCookie()).toEqual([
      "session=abc; Path=/; HttpOnly",
      "theme=dark",
    ]);
  });

  it.effect("does not store a streamed body", () =>
    Effect.sync(() => {
      const response = HttpServerResponse.stream(
        Stream.encodeText(Stream.make("a", "b")),
      );
      expect(StoredResponse.fromResponse(response)).toBeUndefined();
    }),
  );
});
