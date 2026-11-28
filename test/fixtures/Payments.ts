/**
 * A small payments API for the tests: endpoints behind an authentication
 * middleware and an idempotency middleware, and a control group that lets a
 * test hold a charge open and count how many ran, over HTTP as well as in
 * process.
 *
 * Besides the plain JSON endpoint there is one for each kind of body the
 * middleware treats differently: a streamed response, payloads that are a
 * stream or multipart, and an upload whose body is left out of the
 * fingerprint.
 */
import { Context, Effect, Latch, Layer, Schema, Stream } from "effect";
import {
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse,
  type Multipart,
} from "effect/http";
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
    // Streams its response, and charges part way through it.
    HttpApiEndpoint.post("receipt", "/payments/receipt", {
      headers,
      payload: Schema.Struct({ amount: Schema.Number }),
      success: Schema.String.pipe(HttpApiSchema.asText()),
      error: Declined,
    }),
    // A stream of amounts, charged as one payment.
    HttpApiEndpoint.post("batch", "/payments/batch", {
      headers,
      payload: HttpApiSchema.StreamNdjson({
        schema: Schema.Struct({ amount: Schema.Number }),
      }),
      success: Payment,
    }),
    // A multipart form, read whole and with its files saved to disk.
    HttpApiEndpoint.post("invoice", "/payments/invoice", {
      headers,
      payload: Schema.Struct({ amount: Schema.NumberFromString }).pipe(
        HttpApiSchema.asMultipart(),
      ),
      success: Payment,
    }),
    // A multipart form, read part by part.
    HttpApiEndpoint.post("invoiceParts", "/payments/invoice-parts", {
      headers,
      payload: Schema.Unknown.pipe(HttpApiSchema.asMultipartStream()),
      success: Payment,
    }),
    // A body the fingerprint leaves out: it is charged its length in bytes.
    HttpApiEndpoint.post("upload", "/payments/upload", {
      headers,
      payload: HttpApiSchema.StreamUint8Array(),
      success: Payment,
    }).annotate(Idempotency.FingerprintBody, false),
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
        // The first chunk is sent before the charge starts, so a test that
        // holds charges holds the response part way through. The stream
        // reads from a resource the handler opens in its scope, as it would
        // from a database cursor, and dies if that is closed under it. So
        // does a change the handler registers for the response, which says
        // in `x-printer` whether the resource was still open when it ran.
        .handle("receipt", ({ payload }) =>
          Effect.gen(function* () {
            const printer = yield* Effect.acquireRelease(
              Effect.sync(() => ({ open: true })),
              (printer) =>
                Effect.sync(() => {
                  printer.open = false;
                }),
            );
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(
                HttpServerResponse.setHeader(
                  response,
                  "x-printer",
                  printer.open ? "open" : "closed",
                ),
              ),
            );
            return HttpServerResponse.stream(
              Stream.encodeText(
                Stream.concat(
                  Stream.make("receipt for "),
                  Stream.fromEffect(
                    Effect.flatMap(ledger.charge(payload.amount), (p) =>
                      printer.open
                        ? Effect.succeed(p.id)
                        : Effect.die(new Error("The printer was closed")),
                    ),
                  ),
                ),
              ),
              { contentType: "text/plain" },
            );
          }),
        )
        .handle("batch", ({ payload }) =>
          Effect.orDie(
            Effect.flatMap(
              Stream.runFold(
                payload,
                () => 0,
                (sum, line) => sum + line.amount,
              ),
              ledger.charge,
            ),
          ),
        )
        .handle("invoice", ({ payload }) =>
          Effect.orDie(ledger.charge(payload.amount)),
        )
        .handle("invoiceParts", ({ payload }) =>
          Effect.orDie(
            Effect.flatMap(
              Stream.runFold(
                Stream.filter(
                  payload,
                  (part): part is Multipart.Field =>
                    part._tag === "Field" && part.key === "amount",
                ),
                () => 0,
                (sum, field) => sum + Number(field.value),
              ),
              ledger.charge,
            ),
          ),
        )
        .handle("upload", ({ payload }) =>
          Effect.orDie(
            Effect.flatMap(
              Stream.runFold(
                payload,
                () => 0,
                (size, chunk) => size + chunk.length,
              ),
              ledger.charge,
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
    // closing for the end of the request. With `x-request-scope`, it runs in
    // the request's scope instead, as under a middleware that opens none.
    const inner = Effect.provideService(httpEffect, CurrentUser, { id });
    const response =
      request.headers["x-request-scope"] === undefined
        ? yield* Effect.scoped(inner)
        : yield* inner;
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
  options?: Pick<
    Idempotency.Options<CurrentUser>,
    "retention" | "lockExpiry" | "maxStoredBytes"
  >,
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

/** {@link layerWith} the default options. */
export const layer = layerWith();
