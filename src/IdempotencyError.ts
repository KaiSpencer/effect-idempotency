/**
 * The errors the middleware answers with, as RFC 9457 problems.
 *
 * Each is a schema, so an endpoint that carries the middleware documents them
 * in OpenAPI and a generated client receives them in its error channel. The
 * `type` of each problem is a link to its section of the README and never
 * changes.
 *
 * @module
 */
import { HttpApiError } from "effect/http-api";

/** `400`: the request has no `Idempotency-Key` header. */
export class IdempotencyKeyMissing extends HttpApiError.Problem<IdempotencyKeyMissing>()(
  "IdempotencyKeyMissing",
  {
    type: "https://github.com/KaiSpencer/effect-idempotency#idempotency-key-missing",
    status: 400,
    title: "The Idempotency-Key header is missing.",
  },
) {}

/**
 * `400`: the `Idempotency-Key` header is empty, longer than 255 characters,
 * outside printable ASCII, or a quoted string that is not well formed.
 */
export class IdempotencyKeyInvalid extends HttpApiError.Problem<IdempotencyKeyInvalid>()(
  "IdempotencyKeyInvalid",
  {
    type: "https://github.com/KaiSpencer/effect-idempotency#idempotency-key-invalid",
    status: 400,
    title: "The Idempotency-Key header is not a valid key.",
  },
) {}

/** `422`: the key was first used with a different request. */
export class IdempotencyKeyMismatch extends HttpApiError.Problem<IdempotencyKeyMismatch>()(
  "IdempotencyKeyMismatch",
  {
    type: "https://github.com/KaiSpencer/effect-idempotency#idempotency-key-mismatch",
    status: 422,
    title: "The Idempotency-Key was already used with a different request.",
  },
) {}

/** `409`: the first request with this key is still running. Retry later. */
export class IdempotencyKeyInProgress extends HttpApiError.Problem<IdempotencyKeyInProgress>()(
  "IdempotencyKeyInProgress",
  {
    type: "https://github.com/KaiSpencer/effect-idempotency#idempotency-key-in-progress",
    status: 409,
    title: "A request with this Idempotency-Key is still in progress.",
  },
) {}
