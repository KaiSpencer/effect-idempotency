/**
 * The `Idempotency-Key` request header.
 *
 * @module
 */

/** The header's name, lower case as HTTP/2 and Effect's `Headers` carry it. */
export const headerName = "idempotency-key";

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * Reads the key out of an `Idempotency-Key` header value.
 *
 * The IETF draft defines the value as a Structured Field string, so a
 * conforming client sends it in double quotes. Most clients in the wild send
 * it bare, as Stripe's do. Both are accepted and give the same key.
 *
 * Returns `undefined` for an empty value, a value outside printable ASCII, or
 * a quoted string that is not well formed.
 */
export const parse = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!PRINTABLE_ASCII.test(trimmed)) return undefined;
  if (!trimmed.startsWith('"')) return trimmed;
  if (trimmed.length < 2 || !trimmed.endsWith('"')) return undefined;

  let key = "";
  const end = trimmed.length - 1;
  for (let i = 1; i < end; i++) {
    const char = trimmed.charAt(i);
    if (char === '"') return undefined;
    if (char !== "\\") {
      key += char;
      continue;
    }
    const escaped = trimmed.charAt(i + 1);
    if (i + 1 >= end || (escaped !== '"' && escaped !== "\\")) return undefined;
    key += escaped;
    i++;
  }
  return key === "" ? undefined : key;
};
