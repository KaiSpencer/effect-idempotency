import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/http-api";
import { Idempotency, IdempotencyKey } from "effect-idempotency";

export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("app/CurrentUser") {}

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
  { httpApiStatus: 401 },
) {}

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("app/Authentication", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthenticated,
}) {}

// [!region middleware]
export class PaymentIdempotency extends Idempotency.Service<
  PaymentIdempotency,
  { requires: CurrentUser }
>()("app/PaymentIdempotency") {}
// [!endregion middleware]

export const Payment = Schema.Struct({
  id: Schema.String,
  amount: Schema.Number,
});

// [!region endpoint]
const create = HttpApiEndpoint.post("create", "/payments", {
  headers: Schema.Struct({ "idempotency-key": IdempotencyKey.FromHeader }),
  payload: Schema.Struct({ amount: Schema.Number }),
  success: Payment,
});
// [!endregion endpoint]

// [!region group]
const Payments = HttpApiGroup.make("payments")
  .add(create)
  .middleware(PaymentIdempotency)
  // Added after, so it runs first and the user is known.
  .middleware(Authentication);
// [!endregion group]

export const Api = HttpApi.make("api").add(Payments);
