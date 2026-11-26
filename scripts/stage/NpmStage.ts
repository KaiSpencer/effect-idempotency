/**
 * `npm stage`, as a service: the staged versions of a package, and the
 * command that approves one.
 */
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { CliError } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runAttached } from "./runAttached.ts";
import {
  newestFirst,
  type PackageName,
  type StageId,
  StagedVersion,
} from "./StagedVersion.ts";

export class NpmError extends Schema.TaggedError<NpmError>()("NpmError", {
  args: Schema.Array(Schema.String),
  reason: Schema.String,
}) {
  override get [CliError.userMessage]() {
    return `npm ${this.args.join(" ")} failed: ${this.reason}`;
  }
}

/** What `npm stage list --json` prints. */
const StageList = Schema.fromJsonString(Schema.Array(StagedVersion));

/** What `npm --json` prints to stdout when a command fails. */
const NpmJsonFailure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ summary: Schema.String }) }),
);

export class NpmStage extends Context.Service<
  NpmStage,
  {
    /** Every staged version of `packageName`, newest first. */
    list(
      packageName: PackageName,
    ): Effect.Effect<ReadonlyArray<StagedVersion>, NpmError>;
    /** Publishes a staged version. npm asks for two-factor authentication. */
    approve(id: StageId): Effect.Effect<void, NpmError>;
  }
>()("effect-idempotency/scripts/stage/NpmStage") {
  static readonly layer = Layer.effect(
    NpmStage,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Runs `npm <args>` and returns what it prints to stdout. */
      const capture = (args: ReadonlyArray<string>) => {
        const fail = (reason: string) => new NpmError({ args, reason });
        return Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("npm", args));
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== 0) {
            return yield* fail(
              Option.match(Schema.decodeUnknownOption(NpmJsonFailure)(stdout), {
                onSome: ({ error }) => error.summary,
                onNone: () => stderr.trim() || `exited with code ${exitCode}`,
              }),
            );
          }
          return stdout;
        }).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (error) => fail(error.message)),
        );
      };

      const list = Effect.fn("NpmStage.list")(function* (
        packageName: PackageName,
      ) {
        const args = ["stage", "list", packageName, "--json"];
        const staged = yield* capture(args).pipe(
          Effect.flatMap((stdout) =>
            Schema.decodeUnknownEffect(StageList)(stdout).pipe(
              Effect.mapError(
                (issue) =>
                  new NpmError({
                    args,
                    reason: `unexpected output: ${issue.message}`,
                  }),
              ),
            ),
          ),
        );
        return Arr.sort(staged, newestFirst);
      });

      // Approving stops for two-factor authentication in the browser, so npm
      // runs on this terminal.
      const approve = Effect.fn("NpmStage.approve")(function* (id: StageId) {
        const args = ["stage", "approve", id];
        yield* runAttached(spawner, "npm", args).pipe(
          Effect.mapError(({ reason }) => new NpmError({ args, reason })),
        );
      });

      return NpmStage.of({ list, approve });
    }),
  );
}
