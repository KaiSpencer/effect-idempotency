/**
 * Checks a store against the memory store, which is small enough to read and
 * be sure of: for a random sequence of claims, completions, releases and
 * passing time, both must answer every step the same way. A sequence that
 * tells them apart is shrunk to a short one and shown with both answers.
 *
 * It finds the orders of events nobody thought to write a test for, such as
 * a completion after the lock expired and the key was taken and released.
 */
import { Arbitrary, Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { IdempotencyKey, IdempotencyStore } from "../../src/index.ts";
import * as memoryStore from "../../src/internal/memoryStore.ts";
import { expect } from "./EffectTest.ts";

type Store = IdempotencyStore.IdempotencyStore["Service"];

export const lockExpiry = Duration.minutes(5);

// Few keys, scopes and fingerprints, so that steps meet on the same key.
// The times stay well under the day after which the SQL store deletes an
// abandoned claim, which the memory store never does: the longest sequence
// is 40 steps of 30 minutes.
const Command = Schema.Union([
  Schema.TaggedStruct("Claim", {
    scope: Schema.Literals(["alice", "bob"]),
    key: Schema.Literals(["k1", "k2"]),
    fingerprint: Schema.Literals(["f1", "f2"]),
  }),
  // `claim` picks one of the claims made so far, counted from the first.
  Schema.TaggedStruct("Complete", {
    claim: Schema.Literals([0, 1, 2, 3, 4, 5]),
    status: Schema.Literals([200, 201]),
    retention: Schema.Literals([600_000, 1_800_000]),
  }),
  Schema.TaggedStruct("Release", {
    claim: Schema.Literals([0, 1, 2, 3, 4, 5]),
  }),
  Schema.TaggedStruct("Advance", {
    millis: Schema.Literals([1, 299_999, 300_000, 600_000, 1_800_000]),
  }),
  // What a store does in the background, which no answer may show.
  Schema.TaggedStruct("Housekeeping", {}),
]);
type Command = typeof Command.Type;

const commands = Arbitrary.array(Arbitrary.schema(Command), { maxLength: 40 });

/** Runs the sequence on one store and returns what it answered, step by step. */
const answers = (
  store: Store,
  scope: string,
  sequence: ReadonlyArray<Command>,
  housekeeping: Effect.Effect<unknown, unknown>,
) =>
  Effect.gen(function* () {
    const claims: Array<IdempotencyStore.Claim> = [];
    const log: Array<unknown> = [];
    for (const command of sequence) {
      switch (command._tag) {
        case "Claim": {
          const result = yield* store.claim({
            scope: `${scope}/${command.scope}`,
            key: IdempotencyKey.IdempotencyKey.make(command.key),
            fingerprint: IdempotencyStore.Fingerprint.make(command.fingerprint),
            lockExpiry,
          });
          if (result._tag === "Claimed") claims.push(result.claim);
          // Tokens differ between stores and are not part of the answer.
          log.push(result._tag === "Claimed" ? "Claimed" : result);
          break;
        }
        case "Complete": {
          const claim = claims[command.claim];
          if (claim === undefined) break;
          yield* store.complete(
            claim,
            {
              status: command.status,
              headers: { "x-claim": String(command.claim) },
              cookies: [],
              body: new Uint8Array([command.status & 0xff]),
            },
            Duration.millis(command.retention),
          );
          break;
        }
        case "Release": {
          const claim = claims[command.claim];
          if (claim !== undefined) yield* store.release(claim);
          break;
        }
        case "Advance":
          yield* TestClock.adjust(command.millis);
          break;
        case "Housekeeping":
          yield* housekeeping;
          break;
      }
    }
    return log;
  });

let runs = 0;

/**
 * Fails unless `store` answers as the memory store does for `options.runs`
 * random sequences. Run it under the test clock.
 *
 * Both stores read the same clock, so the sequence runs on the memory store
 * first and then, from wherever the clock has got to, on `store`: only the
 * time between steps matters. Each run has a scope of its own, so `store`
 * need not be emptied in between.
 */
export const agreesWithMemoryStore = (
  store: Store,
  options: {
    readonly runs: number;
    /** Run for a `Housekeeping` step, on `store` only. */
    readonly housekeeping?: Effect.Effect<unknown, unknown>;
  },
) =>
  Effect.gen(function* () {
    const both = (sequence: ReadonlyArray<Command>) =>
      Effect.gen(function* () {
        const scope = `run-${++runs}`;
        const expected = yield* answers(
          yield* memoryStore.make,
          scope,
          sequence,
          Effect.void,
        );
        const actual = yield* answers(
          store,
          scope,
          sequence,
          options.housekeeping ?? Effect.void,
        );
        return { actual, expected };
      });

    const result = yield* Arbitrary.checkEffect(
      commands,
      (sequence) =>
        Effect.map(Effect.orDie(both(sequence)), ({ actual, expected }) =>
          Bun.deepEquals(actual, expected, true),
        ),
      { runs: options.runs },
    );
    if (result._tag === "Falsified") {
      // Run the short sequence once more for a diff of the two answers.
      const { actual, expected } = yield* Effect.orDie(
        both(result.shrunkInput),
      );
      expect({ sequence: result.shrunkInput, answers: actual }).toEqual({
        sequence: result.shrunkInput,
        answers: expected,
      });
    }
    const failure = Arbitrary.formatCheckFailure(result);
    if (failure !== undefined) return yield* Effect.die(new Error(failure));
  });
