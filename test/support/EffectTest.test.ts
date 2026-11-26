import { Clock, Context, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it, layer } from "./EffectTest.ts";

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

describe("it.effect", () => {
  it.effect("runs an Effect", () =>
    Effect.gen(function* () {
      expect(yield* Effect.succeed(1)).toBe(1);
    }),
  );

  it.effect("starts the clock at zero and moves it only when told", () =>
    Effect.gen(function* () {
      expect(yield* Clock.currentTimeMillis).toBe(0);
      const fiber = yield* Effect.forkChild(
        Effect.as(Effect.sleep("1 day"), "woke"),
      );
      yield* TestClock.adjust("1 day");
      expect(yield* Fiber.join(fiber)).toBe("woke");
    }),
  );

  let released = false;
  it.effect("provides a scope", () =>
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        released = true;
      }),
    ),
  );
  it("closes that scope when the test ends", () => {
    expect(released).toBe(true);
  });

  it.effect.failing("fails the test when the Effect fails", () =>
    Effect.fail(new Boom()),
  );

  it.effect.failing("fails the test when an assertion throws", () =>
    Effect.sync(() => {
      expect(1).toBe(2);
    }),
  );

  it.effect.each([1, 2, 3])("runs once per case: %d", (n) =>
    Effect.sync(() => {
      expect(n).toBeGreaterThan(0);
    }),
  );

  it.effect.each([
    [1, 2],
    [3, 4],
  ])("passes an array case whole", (pair) =>
    Effect.sync(() => {
      expect(pair).toHaveLength(2);
    }),
  );

  it.effect.skip("skips", () => Effect.die("a skipped test ran"));
});

describe("it.live", () => {
  it.live("uses the real clock", () =>
    Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis;
      yield* Effect.sleep("2 millis");
      expect(before).toBeGreaterThan(1_600_000_000_000);
      expect(yield* Clock.currentTimeMillis).toBeGreaterThan(before);
    }),
  );
});

class Counter extends Context.Service<
  Counter,
  { next: Effect.Effect<number> }
>()("test/Counter") {}

const events: Array<string> = [];
const CounterLive = Layer.effect(
  Counter,
  Effect.gen(function* () {
    events.push("built");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => events.push("released")),
    );
    let count = 0;
    return Counter.of({ next: Effect.sync(() => ++count) });
  }),
);

describe("layer", () => {
  layer(CounterLive)("a block", (it) => {
    it.effect("builds the layer before the first test", () =>
      Effect.gen(function* () {
        expect(events).toEqual(["built"]);
        expect(yield* (yield* Counter).next).toBe(1);
      }),
    );

    it.effect("shares the build with the next test", () =>
      Effect.gen(function* () {
        expect(events).toEqual(["built"]);
        expect(yield* (yield* Counter).next).toBe(2);
      }),
    );

    it.effect("provides the test clock", () =>
      Effect.gen(function* () {
        expect(yield* Clock.currentTimeMillis).toBe(0);
      }),
    );
  });

  layer(CounterLive, { excludeTestServices: true })(
    "a block without test services",
    (it) => {
      it.effect("uses the real clock", () =>
        Effect.gen(function* () {
          expect(yield* Clock.currentTimeMillis).toBeGreaterThan(
            1_600_000_000_000,
          );
          expect(yield* (yield* Counter).next).toBe(1);
        }),
      );
    },
  );

  // Each block built the layer once and released it when its tests were done.
  afterAll(() => {
    expect(events).toEqual(["built", "released", "built", "released"]);
  });
});
