import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Result, Sink, Stream } from "effect";
import type { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process";
import { NpmStage } from "../NpmStage.ts";
import { PackageName, StageId } from "../StagedVersion.ts";
import { npmJson } from "./TestEnvironment.ts";

const packageName = PackageName.make("effect-idempotency");
const stageId = StageId.make("0b1537e6-a624-40d9-85f5-bbfa4771cdf5");

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface Spawned {
  readonly command: string;
  readonly options: ChildProcess.CommandOptions;
}

/**
 * Runs `use` against `NpmStage.layer` over a spawner that answers every
 * command with `reply`, and returns what it spawned.
 */
const withNpm = <A, E>(
  reply: Reply,
  use: (npm: NpmStage["Service"]) => Effect.Effect<A, E>,
) => {
  const spawned: Array<Spawned> = [];
  const bytes = (text = "") => Stream.make(new TextEncoder().encode(text));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") {
        throw new Error("expected a single command");
      }
      const args = command.args.map((arg) =>
        Redacted.isRedacted(arg) ? Redacted.value(arg) : arg,
      );
      spawned.push({
        command: [command.command, ...args].join(" "),
        options: command.options,
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(reply.exitCode ?? 0),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: bytes(reply.stdout),
        stderr: bytes(reply.stderr),
        all: Stream.concat(bytes(reply.stdout), bytes(reply.stderr)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return NpmStage.use(use).pipe(
    Effect.result,
    Effect.provide(
      NpmStage.layer.pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    ),
    Effect.map((result) => ({ result, spawned })),
    Effect.runPromise,
  );
};

describe("NpmStage", () => {
  test("list decodes what npm stage list --json prints", async () => {
    const { result, spawned } = await withNpm(
      { stdout: JSON.stringify([npmJson("0.0.1", "validating")]) },
      (npm) => npm.list(packageName),
    );

    expect(spawned.map((s) => s.command)).toEqual([
      "npm stage list effect-idempotency --json",
    ]);
    const [version] = Result.getOrThrow(result);
    expect(version?.spec).toBe("effect-idempotency@0.0.1");
    expect(version?.inReview).toBe(true);
  });

  test("list puts the newest version first", async () => {
    const { result } = await withNpm(
      {
        stdout: JSON.stringify([
          npmJson("0.2.0"),
          npmJson("0.10.0"),
          npmJson("0.9.1"),
        ]),
      },
      (npm) => npm.list(packageName),
    );

    expect(Result.getOrThrow(result).map((s) => s.spec)).toEqual([
      "effect-idempotency@0.10.0",
      "effect-idempotency@0.9.1",
      "effect-idempotency@0.2.0",
    ]);
  });

  test("a failure carries the summary npm prints as JSON", async () => {
    const { result } = await withNpm(
      {
        exitCode: 1,
        stdout: JSON.stringify({
          error: {
            code: "E404",
            summary: 'staged version "x" not found',
            detail: "",
          },
        }),
      },
      (npm) => npm.list(packageName),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe('staged version "x" not found');
    }
  });

  test("a failure without JSON falls back to stderr", async () => {
    const { result } = await withNpm(
      { exitCode: 1, stderr: "npm error code E401\n" },
      (npm) => npm.list(packageName),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("npm error code E401");
    }
  });

  test("output that is not a list of staged versions fails", async () => {
    const { result } = await withNpm({ stdout: "[{}]" }, (npm) =>
      npm.list(packageName),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toStartWith("unexpected output");
    }
  });

  test("approve runs on the terminal, for two-factor authentication", async () => {
    const { result, spawned } = await withNpm({}, (npm) =>
      npm.approve(stageId),
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(spawned).toEqual([
      {
        command: `npm stage approve ${stageId}`,
        options: { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      },
    ]);
  });

  test("approve fails when npm does", async () => {
    const { result } = await withNpm({ exitCode: 1 }, (npm) =>
      npm.approve(stageId),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("npm exited with code 1");
    }
  });
});
