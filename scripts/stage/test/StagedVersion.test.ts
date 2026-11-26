import { describe, expect, test } from "bun:test";
import { DateTime, Option, Schema, SemVer } from "effect";
import { TestSchema } from "effect/testing";
import {
  DistTag,
  PackageName,
  Shasum,
  StagedVersion,
  StageId,
  StageStatus,
} from "../StagedVersion.ts";
import { npmJson } from "./TestEnvironment.ts";

const decoding = new TestSchema.Asserts(StagedVersion).decoding();

describe("StagedVersion", () => {
  test("decodes what npm stage list --json prints", async () => {
    await decoding.succeed(
      npmJson("0.1.0"),
      new StagedVersion({
        id: StageId.make("id-0.1.0"),
        packageName: PackageName.make("effect-idempotency"),
        version: SemVer.parseUnsafe("0.1.0"),
        tag: DistTag.make("latest"),
        status: StageStatus.make("staged"),
        createdAt: DateTime.makeUnsafe("2026-11-26T14:41:51.008Z"),
        actor: Option.some("GitHub Actions"),
        shasum: Option.some(
          Shasum.make("e406607c8ac3c7e5f5bdcfc7daf9512d7003d977"),
        ),
      }),
    );
  });

  test("decodes without an actor or a shasum", () => {
    const { actor: _actor, shasum: _shasum, ...minimal } = npmJson("0.1.0");
    const staged = Schema.decodeUnknownSync(StagedVersion)(minimal);
    expect(staged.actor).toEqual(Option.none());
    expect(staged.shasum).toEqual(Option.none());
    expect(staged.stagedBy).toBe("2026-11-26 14:41 UTC");
  });

  test("decodes a status it does not know", () => {
    const staged = Schema.decodeUnknownSync(StagedVersion)(
      npmJson("0.1.0", "quarantined"),
    );
    expect(staged.isReady).toBe(false);
    expect(staged.inReview).toBe(false);
  });

  test.each([
    [
      "a package name npm would refuse",
      { packageName: "Not A Name" },
      'Expected an npm package name\n  at ["packageName"]',
    ],
    [
      "a version that is not SemVer",
      { version: "one" },
      'Invalid SemVer "one": expected MAJOR.MINOR.PATCH\n  at ["version"]',
    ],
    [
      "a shasum that is not SHA-1",
      { shasum: "abc" },
      'Expected a SHA-1 hash\n  at ["shasum"]',
    ],
    [
      "a date that is not ISO 8601",
      { createdAt: "yesterday" },
      'Expected a valid UTC DateTime string\n  at ["createdAt"]',
    ],
    [
      "an empty stage id",
      { id: "" },
      'Expected a value with a length of at least 1\n  at ["id"]',
    ],
  ])("refuses %s", async (_name, change, message) => {
    await decoding.fail({ ...npmJson("0.1.0"), ...change }, message);
  });

  test("spec, url and readiness come from the decoded fields", () => {
    const staged = Schema.decodeUnknownSync(StagedVersion)(
      npmJson("1.2.3-beta.1", "validating"),
    );
    expect(staged.spec).toBe("effect-idempotency@1.2.3-beta.1");
    expect(staged.url.href).toBe(
      "https://www.npmjs.com/package/effect-idempotency/v/1.2.3-beta.1",
    );
    expect(staged.inReview).toBe(true);
    expect(staged.isReady).toBe(false);
  });
});

describe("PackageName", () => {
  const packageNames = new TestSchema.Asserts(PackageName).decoding();

  test.each(["effect-idempotency", "@effect/platform-bun", "a.b_c~d"])(
    "accepts %s",
    async (name) => {
      await packageNames.succeed(name);
    },
  );

  test.each(["Uppercase", "has space", "@scope", "", "a".repeat(215)])(
    "refuses %p",
    (name) => {
      expect(Schema.decodeUnknownOption(PackageName)(name)).toEqual(
        Option.none(),
      );
    },
  );
});
