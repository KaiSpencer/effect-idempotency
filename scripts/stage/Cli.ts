/**
 * `bun stage`: shows the versions the release workflow staged on npm, and
 * publishes the one you pick, with two-factor authentication.
 */
import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Queue,
  Schema,
  Terminal,
} from "effect";
import { CliError, Command } from "effect/cli";
import * as Dashboard from "./Dashboard.ts";
import { NpmStage, type StagedVersion } from "./NpmStage.ts";

const PackageJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String }),
);

/** The name of the package in the current directory. */
const readPackageName = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { name } = yield* fs
    .readFileString("package.json")
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)));
  return name;
}).pipe(
  Effect.mapError(
    (cause) =>
      new CliError.UserError({
        cause,
        userMessage: `Could not read the package name from package.json: ${cause.message}. Run this from the repository root.`,
      }),
  ),
);

/** Draws on the alternate screen, which the terminal restores on exit. */
const screen = {
  enter: "\x1b[?1049h\x1b[?25l",
  leave: "\x1b[?25h\x1b[?1049l",
  clear: "\x1b[H\x1b[2J",
};

/**
 * Releasing the terminal's raw mode and key reader lags closing them by a
 * few milliseconds. npm must not start reading keys before then.
 */
const terminalHandOff = Duration.millis(50);

type Outcome =
  | { readonly _tag: "Quit" }
  | { readonly _tag: "Approve"; readonly staged: StagedVersion };

/**
 * Runs the dashboard until the user quits or confirms a version to publish.
 * It holds the terminal until then, so npm can have it afterwards.
 */
const runDashboard = Effect.fn("runDashboard")(function* (
  packageName: string,
  notice: Dashboard.Notice | undefined,
) {
  const terminal = yield* Terminal.Terminal;
  const npm = yield* NpmStage;
  const keys = yield* terminal.readInput;
  // Raw mode can stop a bare newline from returning to the first column.
  const display = (text: string) =>
    terminal.display(text.replaceAll("\n", "\r\n")).pipe(Effect.orDie);
  yield* Effect.acquireRelease(display(screen.enter), () =>
    display(screen.leave),
  );

  const load = npm.list(packageName).pipe(
    Effect.match({
      onSuccess: (staged) => Dashboard.Msg.Loaded({ staged }),
      onFailure: (error) =>
        Dashboard.Msg.LoadFailed({ reason: error[CliError.userMessage] }),
    }),
  );
  // While npm reviews a version, check on it again after a quiet spell.
  const nextKey = (model: Dashboard.Model) => {
    const key = Queue.take(keys).pipe(
      Effect.map(({ key }) => Dashboard.Msg.KeyPressed({ key: key.name })),
      Effect.catch(() => Effect.succeed(Dashboard.Msg.Closed())),
    );
    return Dashboard.awaitsReview(model)
      ? key.pipe(
          Effect.timeoutOrElse({
            duration: Dashboard.reviewPollInterval,
            orElse: () => Effect.succeed(Dashboard.Msg.Tick()),
          }),
        )
      : key;
  };

  let [model, command] = Dashboard.init(packageName, notice);
  while (true) {
    switch (command._tag) {
      case "Quit":
        return { _tag: "Quit" } satisfies Outcome;
      case "Approve":
        return { _tag: "Approve", staged: command.staged } satisfies Outcome;
    }
    yield* display(screen.clear + Dashboard.view(model));
    const msg =
      command._tag === "Refresh" ? yield* load : yield* nextKey(model);
    [model, command] = Dashboard.update(model, msg);
  }
}, Effect.scoped);

const session = Effect.fn("session")(function* () {
  const npm = yield* NpmStage;
  const packageName = yield* readPackageName;
  const published: Array<StagedVersion> = [];
  let notice: Dashboard.Notice | undefined;
  while (true) {
    const outcome = yield* runDashboard(packageName, notice);
    if (outcome._tag === "Quit") break;
    const { staged } = outcome;
    yield* Effect.sleep(terminalHandOff);
    yield* Console.log(
      `Publishing ${staged.spec}. npm asks for two-factor authentication.`,
    );
    notice = yield* npm.approve(staged.id).pipe(
      Effect.match({
        onSuccess: (): Dashboard.Notice => {
          published.push(staged);
          return { tone: "success", text: `Published ${staged.spec}.` };
        },
        onFailure: (error): Dashboard.Notice => ({
          tone: "error",
          text: error[CliError.userMessage],
        }),
      }),
    );
  }
  for (const staged of published) {
    yield* Console.log(`Published ${staged.spec}: ${staged.url}`);
  }
});

export const stage = Command.make("stage", {}, session).pipe(
  Command.withDescription(
    "Shows the versions the release workflow staged on npm. Pick one and confirm to publish it.",
  ),
);
