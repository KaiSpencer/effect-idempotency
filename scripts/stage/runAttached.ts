import { Effect, Schema } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  { reason: Schema.String },
) {}

/**
 * Runs a command on this terminal, so it shows its own output and can ask
 * the user for input, such as two-factor authentication.
 */
export const runAttached = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, CommandFailed> =>
  spawner
    .exitCode(
      ChildProcess.make(command, args, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.mapError((error) => new CommandFailed({ reason: error.message })),
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(
              new CommandFailed({
                reason: `${command} exited with code ${exitCode}`,
              }),
            ),
      ),
    );
