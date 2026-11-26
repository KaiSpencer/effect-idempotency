import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { IdempotencyKey } from "../src/index.ts";

// Compared as plain strings: the brand only exists in the types.
const parse = (value: string): string | undefined =>
  IdempotencyKey.parse(value);

describe("IdempotencyKey.parse", () => {
  test("reads a quoted structured-field string", () => {
    expect(parse('"8e03978e-40d5-43e8-bc93-6894a57f9324"')).toBe(
      "8e03978e-40d5-43e8-bc93-6894a57f9324",
    );
  });

  test("reads a bare value to the same key", () => {
    expect(parse(" 8e03978e-40d5 ")).toBe("8e03978e-40d5");
  });

  test("reads a comma inside a quoted string", () => {
    expect(parse('"k1, k2"')).toBe("k1, k2");
  });

  test("unescapes a quote and a backslash", () => {
    expect(parse('"a\\"b\\\\c"')).toBe('a"b\\c');
  });

  test("accepts a key at the length limit", () => {
    const key = "k".repeat(IdempotencyKey.maxLength);
    expect(parse(key)).toBe(key);
    expect(parse(`"${key}"`)).toBe(key);
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["empty quoted string", '""'],
    ["unterminated quote", '"abc'],
    ["a lone quote", '"'],
    ["unescaped inner quote", '"a"b"'],
    ["unknown escape", '"a\\nb"'],
    ["escape that swallows the closing quote", '"abc\\"'],
    ["non-ASCII", "clé"],
    ["control character", "a\tb"],
    ["two headers joined by a comma", "k1, k2"],
    ["a bare key over the limit", "k".repeat(256)],
    ["a quoted key over the limit", `"${"k".repeat(256)}"`],
  ])("rejects %s", (_name, value) => {
    expect(parse(value)).toBeUndefined();
  });
});

describe("IdempotencyKey.FromHeader", () => {
  const decode = Schema.decodeUnknownSync(IdempotencyKey.FromHeader);
  const encode = Schema.encodeSync(IdempotencyKey.FromHeader);

  test("decodes a quoted and a bare header value to the same key", () => {
    expect<string>(decode('"k1"')).toBe("k1");
    expect<string>(decode("k1")).toBe("k1");
  });

  test("encodes a key as a quoted string", () => {
    expect(encode(IdempotencyKey.IdempotencyKey.make("k1"))).toBe('"k1"');
  });

  test("escapes quotes and backslashes, and reads them back", () => {
    const key = IdempotencyKey.IdempotencyKey.make('a"b\\c');
    expect(encode(key)).toBe('"a\\"b\\\\c"');
    expect(decode(encode(key))).toBe(key);
  });

  test("fails to decode a value that is not a key", () => {
    expect(() => decode('"unterminated')).toThrow();
    expect(() => decode("k".repeat(256))).toThrow();
    expect(() => decode(1)).toThrow();
  });
});

describe("IdempotencyKey.IdempotencyKey", () => {
  test("makes a key from a valid string", () => {
    expect<string>(IdempotencyKey.IdempotencyKey.make("k1")).toBe("k1");
  });

  test.each([
    ["empty", ""],
    ["over the length limit", "k".repeat(256)],
    ["non-ASCII", "clé"],
  ])("refuses to make a key from a string that is %s", (_name, value) => {
    expect(() => IdempotencyKey.IdempotencyKey.make(value)).toThrow();
  });
});
