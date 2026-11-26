/**
 * The `Idempotency-Key` request header and the key it carries.
 *
 * @module
 */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

/** The header's name, lower case as HTTP/2 and Effect's `Headers` carry it. */
export const headerName = "idempotency-key";

/** The longest key accepted, in characters. Stripe's limit is the same. */
export const maxLength = 255;

/**
 * An idempotency key: 1 to {@link maxLength} characters of printable ASCII.
 *
 * The brand means a value of this type has been checked, so a store can size
 * a column for it and never sees a key the middleware would have refused.
 * Build one from a trusted string with `IdempotencyKey.make`.
 */
export const IdempotencyKey = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[\x20-\x7e]+$/, {
      expected: "1 or more printable ASCII characters",
    }),
    Schema.isMaxLength(maxLength),
  ),
  Schema.brand("IdempotencyKey"),
);

/** The type of an {@link IdempotencyKey}. */
export type IdempotencyKey = typeof IdempotencyKey.Type;

const invalid = (message: string) =>
  Effect.fail(new SchemaIssue.InvalidValue({ message }));

/** Reads a Structured Field string, or returns a bare value as it is. */
const unquote = (value: string): Effect.Effect<string, SchemaIssue.Issue> => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) {
    // Two `Idempotency-Key` headers arrive joined by a comma, and which key
    // was meant cannot be told.
    return trimmed.includes(",")
      ? invalid("Expected one key: a key with a comma must be quoted")
      : Effect.succeed(trimmed);
  }
  if (trimmed.length < 2 || !trimmed.endsWith('"')) {
    return invalid("Expected a quoted string to end with a quote");
  }

  let key = "";
  const end = trimmed.length - 1;
  for (let i = 1; i < end; i++) {
    const char = trimmed.charAt(i);
    if (char === '"')
      return invalid("Expected a quote inside a quoted string to be escaped");
    if (char !== "\\") {
      key += char;
      continue;
    }
    const escaped = trimmed.charAt(i + 1);
    if (i + 1 >= end || (escaped !== '"' && escaped !== "\\")) {
      return invalid("Expected a backslash to escape a quote or a backslash");
    }
    key += escaped;
    i++;
  }
  return Effect.succeed(key);
};

const quote = (key: string): string => `"${key.replace(/["\\]/g, "\\$&")}"`;

/**
 * The key as an `Idempotency-Key` header value.
 *
 * Decoding accepts the value in double quotes, which is the Structured Field
 * string the IETF draft defines, and bare, as most clients send it. Both give
 * the same key. A bare value cannot contain a comma, because two headers
 * arrive joined by one. Encoding writes the quoted form.
 *
 * Use it for the header in an endpoint definition, so the header is in the
 * OpenAPI document and a generated client can send it:
 *
 * ```ts
 * HttpApiEndpoint.post("create", "/payments", {
 *   headers: Schema.Struct({ "idempotency-key": IdempotencyKey.FromHeader }),
 * })
 * ```
 */
export const FromHeader = Schema.String.pipe(
  Schema.decodeTo(IdempotencyKey, {
    decode: SchemaGetter.transformEffect(unquote),
    encode: SchemaGetter.transform(quote),
  }),
);

const decodeHeader = Schema.decodeOption(FromHeader);

/**
 * Reads the key out of an `Idempotency-Key` header value, quoted or bare.
 *
 * Returns `undefined` for an empty value, a value outside printable ASCII, a
 * bare value with a comma, a quoted string that is not well formed, or a key
 * longer than {@link maxLength}. {@link FromHeader} is the same reading as a schema.
 */
export const parse = (value: string): IdempotencyKey | undefined =>
  Option.getOrUndefined(decodeHeader(value));
