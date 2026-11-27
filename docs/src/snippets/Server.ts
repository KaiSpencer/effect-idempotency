import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Idempotency, IdempotencyStore } from "effect-idempotency";
import {
  Api,
  Authentication,
  CurrentUser,
  PaymentIdempotency,
  Unauthenticated,
} from "./Api.ts";

const PaymentsHandlers = HttpApiBuilder.group(Api, "payments", (handlers) =>
  handlers.handle("create", ({ payload }) =>
    // Charge the card here. This runs once per key.
    Effect.succeed({ id: crypto.randomUUID(), amount: payload.amount }),
  ),
);

const AuthenticationLive = Layer.succeed(Authentication, {
  bearer: (httpEffect, { credential }) =>
    Redacted.value(credential) === "dev-token"
      ? Effect.provideService(httpEffect, CurrentUser, { id: "user_1" })
      : Effect.fail(new Unauthenticated()),
});

// [!region idempotency]
const PaymentIdempotencyLive = Idempotency.layer(PaymentIdempotency, {
  scope: Effect.map(CurrentUser, (user) => user.id),
}).pipe(Layer.provide(IdempotencyStore.layerMemory));
// [!endregion idempotency]

// [!region api]
const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(PaymentsHandlers),
  Layer.provide([PaymentIdempotencyLive, AuthenticationLive]),
);
// [!endregion api]

HttpRouter.serve(ApiLive).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain,
);
