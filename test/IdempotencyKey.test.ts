import { describe, expect, test } from "bun:test";
import { IdempotencyKey } from "../src/index.ts";

describe("IdempotencyKey.parse", () => {
  test("reads a quoted structured-field string", () => {
    expect(IdempotencyKey.parse('"8e03978e-40d5-43e8-bc93-6894a57f9324"')).toBe(
      "8e03978e-40d5-43e8-bc93-6894a57f9324",
    );
  });

  test("reads a bare value to the same key", () => {
    expect(IdempotencyKey.parse(" 8e03978e-40d5 ")).toBe("8e03978e-40d5");
  });

  test("unescapes a quote and a backslash", () => {
    expect(IdempotencyKey.parse('"a\\"b\\\\c"')).toBe('a"b\\c');
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
  ])("rejects %s", (_name, value) => {
    expect(IdempotencyKey.parse(value)).toBeUndefined();
  });
});
