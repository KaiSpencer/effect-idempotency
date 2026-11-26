/**
 * Effect tests under `bun test`: a small port of `@effect/vitest`.
 *
 * `it.effect` runs an Effect with a scope, a `TestClock` and a `TestConsole`.
 * `it.live` runs it with a scope and the real clock and console. `layer`
 * builds a layer once for a block of tests and releases it after the last one.
 *
 * Left out of the port: `prop`, `flakyTest`, nested layers and per-test layer
 * builds. Bun gives a test no abort signal, so a test that outlives its
 * timeout is reported as failed and its fiber is left running.
 *
 * @module
 */
import { afterAll, beforeAll, describe, test } from "bun:test";
import { Cause, type Context, Effect, Exit, Layer, Scope } from "effect";
import { TestClock, TestConsole } from "effect/testing";

export * from "bun:test";

/** The services `it.effect` provides on top of a scope. */
export type TestServices = TestClock.TestClock | TestConsole.TestConsole;

const TestEnv: Layer.Layer<TestServices> = Layer.mergeAll(
  TestConsole.layer,
  TestClock.layer(),
);

/** Registers one Effect test. `timeout` is in milliseconds. */
export type EffectTest<R> = <A, E>(
  name: string,
  self: () => Effect.Effect<A, E, R>,
  timeout?: number,
) => void;

export interface Tester<R> extends EffectTest<R> {
  readonly skip: EffectTest<R>;
  readonly only: EffectTest<R>;
  readonly todo: EffectTest<R>;
  /** Expects the Effect to fail. */
  readonly failing: EffectTest<R>;
  /**
   * Registers one test per case. The case is passed whole, so an array case
   * arrives as an array and is not spread over the parameters.
   */
  readonly each: <T>(
    cases: ReadonlyArray<T>,
  ) => <A, E>(
    name: string,
    self: (value: T) => Effect.Effect<A, E, R>,
    timeout?: number,
  ) => void;
}

// A test that fails with one error rethrows that error, so a failed `expect`
// keeps its diff. Anything else is rendered as the whole cause.
const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return;
  const error =
    exit.cause.reasons.length === 1 ? Cause.squash(exit.cause) : undefined;
  throw error instanceof Error ? error : new Error(Cause.pretty(exit.cause));
};

type Provide<R> = <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>;

const makeTester = <R>(provide: Provide<R>): Tester<R> => {
  const register =
    (
      base: (
        name: string,
        fn: () => Promise<void>,
        timeout?: number,
      ) => unknown,
    ): EffectTest<R> =>
    (name, self, timeout) => {
      base(name, () => run(provide(Effect.suspend(self))), timeout);
    };

  const each: Tester<R>["each"] = (cases) => (name, self, timeout) => {
    // Bun spreads an array case over the parameters; the extra array stops it.
    const rows = cases.map((value): [typeof value] | typeof value =>
      Array.isArray(value) ? [value] : value,
    );
    test.each(rows as Array<(typeof cases)[number]>)(
      name,
      (value) => run(provide(Effect.suspend(() => self(value)))),
      timeout,
    );
  };

  return Object.assign(register(test), {
    skip: register(test.skip),
    only: register(test.only),
    todo: register(test.todo),
    failing: register(test.failing),
    each,
  });
};

const withMethods = <Methods extends object>(
  methods: Methods,
): Methods & typeof test =>
  new Proxy(test as Methods & typeof test, {
    get: (target, property, receiver) =>
      Object.hasOwn(methods, property)
        ? Reflect.get(methods, property)
        : Reflect.get(target, property, receiver),
  });

/**
 * Bun's `it`, with `it.effect` and `it.live` added.
 *
 * @example
 * it.effect("expires after a day", () =>
 *   Effect.gen(function* () {
 *     const fiber = yield* Effect.forkChild(Effect.sleep("1 day"));
 *     yield* TestClock.adjust("1 day");
 *     yield* Fiber.join(fiber);
 *   }),
 * );
 */
export const it = withMethods({
  effect: makeTester<TestServices | Scope.Scope>((effect) =>
    Effect.provide(Effect.scoped(effect), TestEnv),
  ),
  live: makeTester<Scope.Scope>(Effect.scoped),
});

/**
 * Runs a block of tests against one build of `layer`. The layer is built
 * before the first test and released after the last, so its services are
 * shared: a store filled by one test is still filled in the next.
 *
 * `it.effect` inside the block also gets a `TestClock` and a `TestConsole`,
 * built once and shared like the rest. Pass `excludeTestServices: true` when
 * the block needs real time, as a test against a listening server does.
 *
 * `timeout`, in milliseconds, limits the build and the release.
 */
export const layer: {
  <R, E>(
    layer: Layer.Layer<R, E>,
    options: { readonly excludeTestServices: true; readonly timeout?: number },
  ): (
    name: string,
    f: (it: { readonly effect: Tester<R | Scope.Scope> } & typeof test) => void,
  ) => void;
  <R, E>(
    layer: Layer.Layer<R, E>,
    options?: {
      readonly excludeTestServices?: false;
      readonly timeout?: number;
    },
  ): (
    name: string,
    f: (
      it: {
        readonly effect: Tester<R | TestServices | Scope.Scope>;
      } & typeof test,
    ) => void,
  ) => void;
} =
  <R, E>(
    layer_: Layer.Layer<R, E>,
    options?: {
      readonly excludeTestServices?: boolean;
      readonly timeout?: number;
    },
  ) =>
  (
    name: string,
    f: (
      it: {
        readonly effect: Tester<R | TestServices | Scope.Scope>;
      } & typeof test,
    ) => void,
  ): void => {
    const withTestEnv: Layer.Layer<R | TestServices, E> =
      options?.excludeTestServices === true
        ? (layer_ as Layer.Layer<R | TestServices, E>)
        : Layer.provideMerge(layer_, TestEnv);

    describe(name, () => {
      const scope = Scope.makeUnsafe();
      let context: Context.Context<R | TestServices> | undefined;

      beforeAll(async () => {
        context = await Effect.runPromise(
          Layer.buildWithScope(withTestEnv, scope),
        );
      }, options?.timeout);
      afterAll(
        () => Effect.runPromise(Scope.close(scope, Exit.void)),
        options?.timeout,
      );

      f(
        withMethods({
          effect: makeTester<R | TestServices | Scope.Scope>((effect) =>
            Effect.suspend(() =>
              context === undefined
                ? Effect.die(new Error(`The layer of "${name}" was not built`))
                : Effect.provide(Effect.scoped(effect), context),
            ),
          ),
        }),
      );
    });
  };
