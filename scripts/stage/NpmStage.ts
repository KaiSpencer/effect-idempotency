/**
 * `npm stage`, as a service: the staged versions of a package, and the
 * command that approves one.
 */
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { CliError } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runAttached } from "./runAttached.ts";

/** A version waiting on npm for a maintainer's approval. */
export class StagedVersion extends Schema.Class<StagedVersion>("StagedVersion")(
  {
    id: Schema.String,
    packageName: Schema.String,
    version: Schema.String,
    tag: Schema.String,
    status: Schema.String,
    createdAt: Schema.String,
    actor: Schema.optionalKey(Schema.String),
    shasum: Schema.optionalKey(Schema.String),
  },
) {
  get spec(): string {
    return `${this.packageName}@${this.version}`;
  }

  /** Where the version lives on npmjs.com once published. */
  get url(): string {
    return `https://www.npmjs.com/package/${this.packageName}/v/${this.version}`;
  }

  /**
   * npm reviews every staged version automatically, and refuses to approve
   * one until that review ends.
   */
  get inReview(): boolean {
    return this.status === "validating";
  }
}

export class NpmError extends Schema.TaggedError<NpmError>()("NpmError", {
  args: Schema.Array(Schema.String),
  reason: Schema.String,
}) {
  override get [CliError.userMessage]() {
    return `npm ${this.args.join(" ")} failed: ${this.reason}`;
  }
}

/** What `npm --json` prints to stdout when a command fails. */
const NpmJsonFailure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ summary: Schema.String }) }),
);

export class NpmStage extends Context.Service<
  NpmStage,
  {
    /** Every staged version of `packageName`, oldest first. */
    list(
      packageName: string,
    ): Effect.Effect<ReadonlyArray<StagedVersion>, NpmError>;
    /** Publishes a staged version. npm asks for two-factor authentication. */
    approve(id: string): Effect.Effect<void, NpmError>;
  }
>()("effect-idempotency/scripts/stage/NpmStage") {
  static readonly layer = Layer.effect(
    NpmStage,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Runs `npm <args> --json` and decodes what it prints. */
      const json = <A>(
        schema: Schema.Codec<A, unknown>,
        args: ReadonlyArray<string>,
      ): Effect.Effect<A, NpmError> => {
        const fullArgs = [...args, "--json"];
        const fail = (reason: string) =>
          new NpmError({ args: fullArgs, reason });
        return Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("npm", fullArgs),
          );
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
          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(schema),
          )(stdout).pipe(
            Effect.mapError((issue) =>
              fail(`unexpected output: ${issue.message}`),
            ),
          );
        }).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (error) => fail(error.message)),
        );
      };

      return NpmStage.of({
        list: (packageName) =>
          json(Schema.Array(StagedVersion), [
            "stage",
            "list",
            packageName,
          ]).pipe(Effect.withSpan("NpmStage.list")),
        // Approving stops for two-factor authentication in the browser, so
        // npm runs on this terminal.
        approve: (id) => {
          const args = ["stage", "approve", id];
          return runAttached(spawner, "npm", args).pipe(
            Effect.mapError(({ reason }) => new NpmError({ args, reason })),
            Effect.withSpan("NpmStage.approve"),
          );
        },
      });
    }),
  );
}
