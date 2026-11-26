/**
 * In-memory stand-ins for what `bun stage` talks to: npm, the file system,
 * and a terminal that types a script of keys and records every frame.
 */
import {
  type Cause,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Stdio,
  Terminal,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";
import { NpmError, NpmStage, StagedVersion } from "../NpmStage.ts";

export const packageName = "effect-idempotency";

export const stagedVersion = (
  version: string,
  status = "staged",
): StagedVersion =>
  new StagedVersion({
    id: `id-${version}`,
    packageName,
    version,
    tag: "latest",
    status,
    createdAt: "2026-11-26T14:41:51.008Z",
    actor: "GitHub Actions",
    shasum: "e406607c8ac3c7e5f5bdcfc7daf9512d7003d977",
  });

export interface FakeNpmOptions {
  readonly staged: ReadonlyArray<StagedVersion>;
  /** How many `npm stage list` calls still find the review running. */
  readonly reviewLists?: number;
  /** Makes `npm stage list` fail with this reason. */
  readonly listFails?: string;
  /** Makes `npm stage approve` fail with this reason. */
  readonly approveFails?: string;
}

/**
 * A fake `npm stage` over a list of staged versions: approving one publishes
 * it, so it leaves the list. Each call lands in `calls`, as the npm command
 * it stands for.
 */
export const fakeNpm = (options: FakeNpmOptions) => {
  const calls: Array<string> = [];
  let staged = options.staged;
  let reviewLists = options.reviewLists ?? 0;

  const layer = Layer.succeed(
    NpmStage,
    NpmStage.of({
      list: (name) =>
        Effect.suspend(() => {
          calls.push(`npm stage list ${name}`);
          if (options.listFails !== undefined) {
            return Effect.fail(
              new NpmError({
                args: ["stage", "list"],
                reason: options.listFails,
              }),
            );
          }
          const reviewing = reviewLists > 0;
          reviewLists -= 1;
          return Effect.succeed(
            staged.map((s) =>
              reviewing || !s.inReview
                ? s
                : new StagedVersion({ ...s, status: "staged" }),
            ),
          );
        }),
      approve: (id) =>
        Effect.suspend(() => {
          calls.push(`npm stage approve ${id}`);
          if (options.approveFails !== undefined) {
            return Effect.fail(
              new NpmError({
                args: ["stage", "approve", id],
                reason: options.approveFails,
              }),
            );
          }
          staged = staged.filter((s) => s.id !== id);
          return Effect.void;
        }),
    }),
  );

  return { calls, layer };
};

/** A key to press, by name ("down", "return", "q"), or a pause. */
export type Keystroke = string | Duration.Duration;

const keyPress = (name: string): Terminal.UserInput => ({
  input: name.length === 1 ? Option.some(name) : Option.none(),
  key: { name, ctrl: false, meta: false, shift: false },
});

/**
 * A terminal that types `keystrokes` and then ends its input, like ctrl-c.
 * One script serves every screen the session opens, the way one keyboard
 * would. `frames` holds what it displayed, without the screen controls.
 */
export const fakeTerminal = (keystrokes: ReadonlyArray<Keystroke>) => {
  const frames: Array<string> = [];
  const layer = Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const keys = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (const keystroke of keystrokes) {
            if (Duration.isDuration(keystroke)) {
              yield* Effect.sleep(keystroke);
            } else {
              yield* Queue.offer(keys, keyPress(keystroke));
            }
          }
          yield* Queue.end(keys);
        }),
      );
      return Terminal.make({
        columns: Effect.succeed(100),
        rows: Effect.succeed(30),
        size: Effect.die("size is not used"),
        readInput: Effect.succeed(keys),
        readLine: Effect.die("readLine is not used"),
        display: (text) =>
          Effect.sync(() => {
            const plain = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
            if (plain !== "") frames.push(plain);
          }),
      });
    }),
  );
  return { frames, layer };
};

/** Everything else `Command.runWith` needs. */
export const cliEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({
    readFileString: () => Effect.succeed(JSON.stringify({ name: packageName })),
  }),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("spawning is not used")),
  ),
  TestConsole.layer,
);
