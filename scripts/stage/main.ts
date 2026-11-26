/**
 * Entry point of `bun stage`. See `Cli.ts`.
 */
import { BunRuntime, BunServices, BunTerminal } from "@effect/platform-bun";
import { Effect, Layer, Terminal } from "effect";
import { Command } from "effect/cli";
import { stage } from "./Cli.ts";
import { NpmStage } from "./NpmStage.ts";

/**
 * Only ctrl-c and ctrl-d end the input. The default terminal also ends it on
 * escape, which the dashboard uses to go back.
 */
const TerminalLayer = Layer.effect(
  Terminal.Terminal,
  BunTerminal.make(
    ({ key }) => key.ctrl && (key.name === "c" || key.name === "d"),
  ),
);

const MainLayer = NpmStage.layer.pipe(
  Layer.provideMerge(Layer.merge(BunServices.layer, TerminalLayer)),
);

stage.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(MainLayer),
  BunRuntime.runMain,
);
