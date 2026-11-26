import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Layer, Result } from "effect";
import { Command } from "effect/cli";
import { TestClock, TestConsole } from "effect/testing";
import { stage } from "../Cli.ts";
import {
  cliEnvironment,
  type FakeNpmOptions,
  fakeNpm,
  fakeTerminal,
  type Keystroke,
  stagedVersion,
} from "./TestEnvironment.ts";

/**
 * Runs `bun stage` against a fake npm, typing `keystrokes`, with a clock that
 * runs as far as the session needs.
 */
const runStage = (
  npmOptions: FakeNpmOptions,
  keystrokes: ReadonlyArray<Keystroke>,
) => {
  const npm = fakeNpm(npmOptions);
  const terminal = fakeTerminal(keystrokes);
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      Effect.result(Command.runWith(stage, { version: "test" })([])),
    );
    // Let time pass a second at a time, so every sleep and timeout the
    // session starts along the way also comes due.
    for (let second = 0; fiber.pollUnsafe() === undefined; second++) {
      if (second > 3600) throw new Error("bun stage did not finish");
      yield* TestClock.adjust(Duration.seconds(1));
    }
    const result = yield* Fiber.join(fiber);
    const output = (yield* TestConsole.logLines).join("\n");
    return { result, output, calls: npm.calls, frames: terminal.frames };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(npm.layer, terminal.layer, cliEnvironment).pipe(
        Layer.provideMerge(TestClock.layer()),
      ),
    ),
    Effect.runPromise,
  );
};

const lastFrame = (frames: ReadonlyArray<string>) => frames.at(-1) ?? "";

describe("bun stage", () => {
  test("lists the staged versions", async () => {
    const run = await runStage(
      {
        staged: [stagedVersion("0.1.0"), stagedVersion("0.2.0", "validating")],
        reviewLists: 1,
      },
      ["q"],
    );

    expect(Result.isSuccess(run.result)).toBe(true);
    expect(lastFrame(run.frames)).toContain("› 0.1.0  ● ready to publish");
    expect(lastFrame(run.frames)).toContain("  0.2.0  ◌ npm is reviewing");
  });

  test("publishes after enter, then enter again on the confirmation", async () => {
    const run = await runStage({ staged: [stagedVersion("0.1.0")] }, [
      "return",
      "return",
      "q",
    ]);

    expect(Result.isSuccess(run.result)).toBe(true);
    expect(run.calls).toEqual([
      "npm stage list effect-idempotency",
      "npm stage approve id-0.1.0",
      "npm stage list effect-idempotency",
    ]);
    expect(run.frames.join("\n")).toContain(
      "Publish effect-idempotency@0.1.0?",
    );
    expect(lastFrame(run.frames)).toContain(
      "Published effect-idempotency@0.1.0.",
    );
    expect(lastFrame(run.frames)).toContain("Nothing is staged.");
    expect(run.output).toContain(
      "Published effect-idempotency@0.1.0: https://www.npmjs.com/package/effect-idempotency/v/0.1.0",
    );
  });

  test("publishes the version the cursor is on", async () => {
    const run = await runStage(
      { staged: [stagedVersion("0.1.0"), stagedVersion("0.2.0")] },
      ["down", "return", "return", "q"],
    );

    expect(run.calls).toContain("npm stage approve id-0.2.0");
    expect(run.calls).not.toContain("npm stage approve id-0.1.0");
  });

  test("escape on the confirmation goes back without publishing", async () => {
    const run = await runStage({ staged: [stagedVersion("0.1.0")] }, [
      "return",
      "escape",
      "q",
    ]);

    expect(run.calls).toEqual(["npm stage list effect-idempotency"]);
    expect(lastFrame(run.frames)).toContain("› 0.1.0");
  });

  test("a version npm still reviews cannot be published yet", async () => {
    const run = await runStage(
      { staged: [stagedVersion("0.1.0", "validating")], reviewLists: 10 },
      ["return", "q"],
    );

    expect(run.calls).not.toContain("npm stage approve id-0.1.0");
    expect(run.frames.join("\n")).toContain(
      "npm is still reviewing effect-idempotency@0.1.0",
    );
  });

  test("r refreshes the list", async () => {
    const run = await runStage({ staged: [stagedVersion("0.1.0")] }, [
      "r",
      "q",
    ]);

    expect(run.calls).toEqual([
      "npm stage list effect-idempotency",
      "npm stage list effect-idempotency",
    ]);
  });

  test("checks on a review by itself until the version is ready", async () => {
    const run = await runStage(
      { staged: [stagedVersion("0.1.0", "validating")], reviewLists: 2 },
      [Duration.minutes(1), "return", "return", "q"],
    );

    expect(run.calls).toEqual([
      "npm stage list effect-idempotency",
      "npm stage list effect-idempotency",
      "npm stage list effect-idempotency",
      "npm stage approve id-0.1.0",
      "npm stage list effect-idempotency",
    ]);
  });

  test("shows why npm failed to publish, and keeps the version", async () => {
    const run = await runStage(
      {
        staged: [stagedVersion("0.1.0")],
        approveFails: "409 Conflict",
      },
      ["return", "return", "q"],
    );

    expect(Result.isSuccess(run.result)).toBe(true);
    expect(lastFrame(run.frames)).toContain(
      "npm stage approve id-0.1.0 failed: 409 Conflict",
    );
    expect(lastFrame(run.frames)).toContain("› 0.1.0");
    expect(run.output).not.toContain("Published");
  });

  test("shows why npm failed to list", async () => {
    const run = await runStage({ staged: [], listFails: "E401 Unauthorized" }, [
      "q",
    ]);

    expect(Result.isSuccess(run.result)).toBe(true);
    expect(lastFrame(run.frames)).toContain("E401 Unauthorized");
  });

  test("ctrl-c quits", async () => {
    const run = await runStage({ staged: [stagedVersion("0.1.0")] }, []);

    expect(Result.isSuccess(run.result)).toBe(true);
    expect(run.calls).toEqual(["npm stage list effect-idempotency"]);
  });
});
