/**
 * A small payments API for the tests: one endpoint behind an authentication
 * middleware and an idempotency middleware, and a control group that lets a
 * test hold a charge open and count how many ran, over HTTP as well as in
 * process.
 */
import { Context, Effect, Latch, Layer, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/http-api";
import { Idempotency, IdempotencyKey } from "../../src/index.ts";

export const Payment = Schema.Struct({
  id: Schema.String,
  amount: Schema.Number,
});

export class Declined extends Schema.TaggedError<Declined>()(
  "Declined",
  { reason: Schema.String },
  { httpApiStatus: 402 },
) {}

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
  { httpApiStatus: 401 },
) {}

export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("test/CurrentUser") {}

/** Takes the user from the `x-user` header. */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("test/Authentication", { error: Unauthenticated }) {}

export class PaymentIdempotency extends Idempotency.Service<
  PaymentIdempotency,
  { requires: CurrentUser }
>()("test/PaymentIdempotency") {}

// The key is declared with its codec, so it is in the OpenAPI document and a
// typed client sends it. It is optional here only so that a test can leave it
// out; an API would require it.
const headers = Schema.Struct({
  "x-user": Schema.optional(Schema.String),
  "idempotency-key": Schema.optional(IdempotencyKey.FromHeader),
});

const PaymentsGroup = HttpApiGroup.make("payments")
  .add(
    HttpApiEndpoint.post("create", "/payments", {
      headers,
      payload: Schema.Struct({ amount: Schema.Number }),
      success: Payment,
      error: Declined,
    }),
    HttpApiEndpoint.post("receipt", "/payments/receipt", {
      headers,
      success: Schema.String.pipe(HttpApiSchema.asText()),
    }),
    HttpApiEndpoint.post("checkout", "/payments/checkout", {
      headers,
      success: Payment,
    }),
  )
  // The middleware added last runs first, so the user is known by the time
  // the idempotency middleware asks for its scope.
  .middleware(PaymentIdempotency)
  .middleware(Authentication);

const ControlGroup = HttpApiGroup.make("control").add(
  HttpApiEndpoint.get("charges", "/control/charges", {
    success: Schema.Number,
  }),
  HttpApiEndpoint.post("hold", "/control/hold"),
  HttpApiEndpoint.post("resume", "/control/resume"),
);

export const Api = HttpApi.make("payments-test")
  .add(PaymentsGroup)
  .add(ControlGroup);

/**
 * The side effect behind the API. An amount below zero is declined and an
 * amount of zero dies, so a test picks the handler's outcome with the payload.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly charge: (
      amount: number,
    ) => Effect.Effect<typeof Payment.Type, Declined>;
    /** How many charges have started. */
    readonly charges: Effect.Effect<number>;
    /** Makes every charge wait, after it has started, until `resume`. */
    readonly hold: Effect.Effect<void>;
    readonly resume: Effect.Effect<void>;
    /** Waits until a charge is waiting on `hold`. */
    readonly held: Effect.Effect<void>;
  }
>()("test/Ledger") {
  static readonly layer = Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const gate = yield* Latch.make(true);
      const held = yield* Latch.make(false);
      let charges = 0;
      return Ledger.of({
        charge: (amount) =>
          Effect.gen(function* () {
            const id = `pay_${++charges}`;
            if (!Latch.isOpen(gate)) yield* held.open;
            yield* gate.await;
            if (amount < 0)
              return yield* new Declined({ reason: "negative amount" });
            if (amount === 0)
              return yield* Effect.die(new Error("the ledger is down"));
            return { id, amount };
          }),
        charges: Effect.sync(() => charges),
        hold: Effect.andThen(held.close, gate.close),
        resume: Effect.asVoid(gate.open),
        held: held.await,
      });
    }),
  );
}

const lastPayment = HttpApiSecurity.apiKey({
  in: "cookie",
  key: "last-payment",
});

const PaymentsHandlers = HttpApiBuilder.group(
  Api,
  "payments",
  Effect.fnUntraced(function* (handlers) {
    const ledger = yield* Ledger;
    return (
      handlers
        .handle("create", ({ payload }) => ledger.charge(payload.amount))
        // Sets its cookie the way `securitySetCookie` does: as a change to the
        // response that Effect makes later, just before sending it.
        .handle("checkout", () =>
          Effect.tap(Effect.orDie(ledger.charge(1)), (payment) =>
            HttpApiBuilder.securitySetCookie(lastPayment, payment.id),
          ),
        )
        .handle("receipt", () =>
          Effect.map(Effect.orDie(ledger.charge(1)), (payment) =>
            HttpServerResponse.stream(
              Stream.encodeText(Stream.make("receipt for ", payment.id)),
              {
                contentType: "text/plain",
              },
            ),
          ),
        )
    );
  }),
);

const ControlHandlers = HttpApiBuilder.group(
  Api,
  "control",
  Effect.fnUntraced(function* (handlers) {
    const ledger = yield* Ledger;
    return handlers
      .handle("charges", () => ledger.charges)
      .handle("hold", () => ledger.hold)
      .handle("resume", () => ledger.resume);
  }),
);

const AuthenticationLive = Layer.succeed(Authentication, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = request.headers["x-user"];
    if (id === undefined) return yield* new Unauthenticated();
    // The rest of the request runs in a scope of its own, as it does under a
    // middleware that opens a resource per request. That scope closes before
    // the response is sent, and the idempotency middleware must not take its
    // closing for the end of the request.
    const response = yield* Effect.scoped(
      Effect.provideService(httpEffect, CurrentUser, { id }),
    );
    // Lets a test make the request fail after its handler has succeeded.
    if (request.headers["x-fail-after-handler"] !== undefined) {
      return yield* new Unauthenticated();
    }
    return response;
  }),
);

/**
 * The handlers and middleware of the API, with the ledger left in the output
 * so a test can read it. The store comes from the caller.
 */
export const layerWith = (
  options?: Pick<Idempotency.Options<CurrentUser>, "retention" | "lockExpiry">,
) =>
  Layer.mergeAll(PaymentsHandlers, ControlHandlers).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        AuthenticationLive,
        Idempotency.layer(PaymentIdempotency, {
          scope: Effect.map(CurrentUser, (user) => user.id),
          ...options,
        }),
      ),
    ),
    Layer.provideMerge(Ledger.layer),
  );

/** {@link layerWith} the default retention and lock expiry. */
export const layer = layerWith();
