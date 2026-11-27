import { ByteSize, Effect, Layer } from "effect";
import { HttpIncomingMessage } from "effect/http";
import { IdempotencyStore } from "../../src/index.ts";
import { describe, expect, it } from "../support/EffectTest.ts";
import { serve } from "./bunServer.ts";
import { charges, create, idempotencyScenarios } from "./scenarios.ts";

idempotencyScenarios(
  "Bun.serve with HttpRouter.toWebHandler",
  serve(IdempotencyStore.layerMemory),
);

describe("Bun.serve with a maximum body size", () => {
  // `{"amount":5}` is 12 bytes.
  const server = serve(
    Layer.merge(
      IdempotencyStore.layerMemory,
      Layer.succeed(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(12)),
    ),
  );

  it.live("answers 413 to a larger body without claiming its key", () =>
    Effect.gen(function* () {
      const refused = yield* create(5, { body: '{"amount": 5}' });
      expect(refused.status).toBe(413);

      const accepted = yield* create(5);
      expect(accepted.status).toBe(200);
      expect(accepted.headers["idempotent-replayed"]).toBeUndefined();
      expect(yield* charges).toBe(1);
    }).pipe(Effect.provide(server)),
  );
});
