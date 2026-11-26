/**
 * In-memory stand-ins for what `bun stage` talks to: npm, the file system,
 * and a terminal that types a script of keys and records every frame.
 */
import { stripVTControlCharacters } from "node:util";
import {
  type Cause,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Array as Arr,
  Schema,
  Stdio,
  Terminal,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";
import { NpmError, NpmStage } from "../NpmStage.ts";
import {
  newestFirst,
  PackageName,
  StagedVersion,
  StageStatus,
  type StageId,
} from "../StagedVersion.ts";

export const packageName = PackageName.make("effect-idempotency");

/** A staged version as `npm stage list --json` prints it. */
export const npmJson = (version: string, status = "staged") => ({
  id: `id-${version}`,
  packageName,
  version,
  tag: "latest",
  createdAt: "2026-11-26T14:41:51.008Z",
  actor: "GitHub Actions",
  actorType: "trusted automation",
  access: "public",
  shasum: "e406607c8ac3c7e5f5bdcfc7daf9512d7003d977",
  status,
});

/** A staged version, decoded from what npm prints, as the service does. */
export const stagedVersion = (
  version: string,
  status = "staged",
): StagedVersion =>
  Schema.decodeUnknownSync(StagedVersion)(npmJson(version, status));

export interface FakeNpmOptions {
  readonly staged: ReadonlyArray<StagedVersion>;
  /** How many `npm stage list` calls still find the review running. */
  readonly reviewLists?: number;
  /** Makes `npm stage list` fail with this reason. */
  readonly listFails?: string;
  /** Makes `npm stage approve` fail with this reason. */
  readonly approveFails?: string;
  /**
   * How many `npm stage list` calls still list a version after approving it,
   * as when npm takes a while to publish.
   */
  readonly publishLists?: number;
}

/**
 * A fake `npm stage` over a list of staged versions: approving one publishes
 * it, so it leaves the list, after `publishLists` more lists. Each call lands
 * in `calls`, as the npm command it stands for.
 */
export const fakeNpm = (options: FakeNpmOptions) => {
  const calls: Array<string> = [];
  let staged = options.staged;
  let reviewLists = options.reviewLists ?? 0;
  /** Approved versions, by id, and how many more lists still show them. */
  const publishing = new Map<StageId, number>();

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
          for (const [id, lists] of publishing) {
            if (lists > 0) {
              publishing.set(id, lists - 1);
            } else {
              publishing.delete(id);
              staged = staged.filter((s) => s.id !== id);
            }
          }
          const reviewing = reviewLists > 0;
          reviewLists -= 1;
          return Effect.succeed(
            Arr.sort(
              staged.map((s) =>
                reviewing || !s.inReview
                  ? s
                  : new StagedVersion({
                      ...s,
                      status: StageStatus.make("staged"),
                    }),
              ),
              newestFirst,
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
          publishing.set(id, options.publishLists ?? 0);
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
            const plain = stripVTControlCharacters(text).replaceAll(
              "\r\n",
              "\n",
            );
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
