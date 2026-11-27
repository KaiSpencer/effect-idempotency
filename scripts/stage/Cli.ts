/**
 * `bun stage`: shows the versions the release workflow staged on npm, and
 * publishes the one you pick, with two-factor authentication.
 */
import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Queue,
  Schema,
  Terminal,
} from "effect";
import { CliError, Command } from "effect/cli";
import * as Dashboard from "./Dashboard.ts";
import { NpmStage } from "./NpmStage.ts";
import { PackageName } from "./StagedVersion.ts";

const PackageJson = Schema.fromJsonString(Schema.Struct({ name: PackageName }));

const decodeKey = Schema.decodeUnknownOption(Dashboard.Key);

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

/** Where the dashboard hands control back: to quit, or to approve. */
type Exit = readonly [
  Dashboard.Model,
  Extract<Dashboard.Command, { readonly _tag: "Quit" | "Approve" }>,
];

/**
 * Runs the dashboard until the user quits or confirms a version to publish.
 * It holds the terminal until then, so npm can have it afterwards.
 */
const runDashboard = Effect.fn("runDashboard")(function* (
  step: Dashboard.Step,
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

  const load = (model: Dashboard.Model) =>
    npm.list(model.packageName).pipe(
      Effect.match({
        onSuccess: (staged) => Dashboard.Msg.Loaded({ staged }),
        onFailure: (error) =>
          Dashboard.Msg.LoadFailed({ reason: error[CliError.userMessage] }),
      }),
    );
  // While npm works on a version, check on it again after a quiet spell.
  const nextKey = (model: Dashboard.Model) => {
    // Keys the dashboard does not answer are skipped here.
    const key = Effect.gen(function* () {
      while (true) {
        const input = yield* Queue.take(keys);
        const key = decodeKey(input.key.name);
        if (Option.isSome(key)) {
          return Dashboard.Msg.KeyPressed({ key: key.value });
        }
      }
    }).pipe(Effect.catch(() => Effect.succeed(Dashboard.Msg.Closed())));
    return Dashboard.awaitsNpm(model)
      ? key.pipe(
          Effect.timeoutOrElse({
            duration: Dashboard.pollInterval,
            orElse: () => Effect.succeed(Dashboard.Msg.Tick()),
          }),
        )
      : key;
  };

  let [model, command] = step;
  while (true) {
    if (command._tag === "Quit" || command._tag === "Approve") {
      const exit: Exit = [model, command];
      return exit;
    }
    yield* display(screen.clear + Dashboard.view(model));
    const msg =
      command._tag === "Refresh" ? yield* load(model) : yield* nextKey(model);
    [model, command] = Dashboard.update(model, msg);
  }
}, Effect.scoped);

const session = Effect.fn("session")(function* () {
  const npm = yield* NpmStage;
  let step = Dashboard.init(yield* readPackageName);
  while (true) {
    const [model, command] = yield* runDashboard(step);
    if (command._tag === "Quit") {
      for (const staged of model.published) {
        yield* Console.log(`Published ${staged.spec}: ${staged.url}`);
      }
      for (const staged of model.publishing) {
        yield* Console.log(
          `npm is still publishing ${staged.spec}. It appears at ${staged.url} once done.`,
        );
      }
      return;
    }
    const { staged } = command;
    yield* Effect.sleep(terminalHandOff);
    yield* Console.log(
      `Publishing ${staged.spec}. npm asks for two-factor authentication.`,
    );
    // Back on the dashboard, the list refreshes until npm has published it.
    const result = yield* npm.approve(staged.id).pipe(
      Effect.match({
        onSuccess: () => Dashboard.Msg.Approved({ staged }),
        onFailure: (error) =>
          Dashboard.Msg.ApproveFailed({
            reason: error[CliError.userMessage],
          }),
      }),
    );
    step = Dashboard.update(model, result);
  }
});

export const stage = Command.make("stage", {}, session).pipe(
  Command.withDescription(
    "Shows the versions the release workflow staged on npm. Pick one and confirm to publish it.",
  ),
);
