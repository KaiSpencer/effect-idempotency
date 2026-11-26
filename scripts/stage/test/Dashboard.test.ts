import { describe, expect, test } from "bun:test";
import { Arbitrary, Effect, Option, Schema } from "effect";
import * as Dashboard from "../Dashboard.ts";
import type { StagedVersion } from "../StagedVersion.ts";
import { packageName, stagedVersion } from "./TestEnvironment.ts";

const { Command, Msg } = Dashboard;

/** The dashboard after loading `staged` and pressing `keys`. */
const after = (
  staged: ReadonlyArray<StagedVersion>,
  keys: ReadonlyArray<Dashboard.Key> = [],
): Dashboard.Step => {
  let step = Dashboard.update(
    Dashboard.init(packageName)[0],
    Msg.Loaded({ staged }),
  );
  for (const key of keys) {
    step = Dashboard.update(step[0], Msg.KeyPressed({ key }));
  }
  return step;
};

const noticeText = (model: Dashboard.Model) =>
  Option.map(model.notice, (notice) => notice.text).pipe(Option.getOrUndefined);

const confirmingVersion = (model: Dashboard.Model) =>
  Option.map(model.confirming, (staged) => staged.spec).pipe(
    Option.getOrUndefined,
  );

// Newest first, as npm stage list is read.
const versions = [stagedVersion("0.2.0"), stagedVersion("0.1.0")];

describe("Dashboard.update", () => {
  test("starts by loading", () => {
    const [model, command] = Dashboard.init(packageName);
    expect(model.loading).toBe(true);
    expect(command).toEqual(Command.Refresh());
  });

  test("moves the cursor within the list", () => {
    expect(after(versions, ["down"])[0].cursor).toBe(1);
    expect(after(versions, ["down", "down", "down"])[0].cursor).toBe(1);
    expect(after(versions, ["j", "k", "up"])[0].cursor).toBe(0);
  });

  test("enter on a ready version asks for confirmation", () => {
    const [model, command] = after(versions, ["down", "return"]);
    expect(confirmingVersion(model)).toBe("effect-idempotency@0.1.0");
    expect(command).toEqual(Command.Wait());
  });

  test("enter on the confirmation approves", () => {
    const [, command] = after(versions, ["return", "return"]);
    expect(command).toEqual(Command.Approve({ staged: versions[0]! }));
  });

  test("other keys on the confirmation do not approve", () => {
    const [model, command] = after(versions, ["return", "r", "j"]);
    expect(confirmingVersion(model)).toBe("effect-idempotency@0.2.0");
    expect(command).toEqual(Command.Wait());
  });

  test("escape leaves the confirmation, then quits", () => {
    expect(after(versions, ["return", "escape"])[0].confirming).toEqual(
      Option.none(),
    );
    expect(after(versions, ["return", "escape", "escape"])[1]).toEqual(
      Command.Quit(),
    );
  });

  test("enter on a version in review explains instead", () => {
    const [model] = after([stagedVersion("0.1.0", "validating")], ["return"]);
    expect(model.confirming).toEqual(Option.none());
    expect(noticeText(model)).toContain("still reviewing");
  });

  test("enter on a version in another state explains instead", () => {
    const [model] = after([stagedVersion("0.1.0", "rejected")], ["return"]);
    expect(model.confirming).toEqual(Option.none());
    expect(noticeText(model)).toBe(
      "effect-idempotency@0.1.0 is rejected on npm, so it cannot be published from here.",
    );
  });

  test("the next key press dismisses a notice", () => {
    const [model] = after(
      [stagedVersion("0.1.0", "validating")],
      ["return", "down"],
    );
    expect(model.notice).toEqual(Option.none());
  });

  test("keeps the cursor on the list when it shrinks", () => {
    const [moved] = after(versions, ["down"]);
    const [model] = Dashboard.update(
      moved,
      Msg.Loaded({ staged: [versions[0]!] }),
    );
    expect(model.cursor).toBe(0);
  });

  test("a tick refreshes", () => {
    const [model, command] = Dashboard.update(after(versions)[0], Msg.Tick());
    expect(model.loading).toBe(true);
    expect(command).toEqual(Command.Refresh());
  });

  test("closed input quits", () => {
    expect(Dashboard.update(after(versions)[0], Msg.Closed())[1]).toEqual(
      Command.Quit(),
    );
  });
});

describe("Dashboard.update after approving", () => {
  const approved = () => {
    const [model] = after(versions, ["return"]);
    return Dashboard.update(model, Msg.Approved({ staged: versions[0]! }));
  };

  test("refreshes and marks the version as publishing", () => {
    const [model, command] = approved();
    expect(command).toEqual(Command.Refresh());
    expect(model.confirming).toEqual(Option.none());
    expect(Dashboard.progressOf(model, versions[0]!)).toBe("publishing");
    expect(Dashboard.awaitsNpm(model)).toBe(true);
  });

  test("still publishing while npm lists the version", () => {
    const [model] = Dashboard.update(
      approved()[0],
      Msg.Loaded({ staged: versions }),
    );
    expect(Dashboard.progressOf(model, versions[0]!)).toBe("publishing");
    expect(model.published).toEqual([]);
  });

  test("published once npm no longer lists it", () => {
    const [model] = Dashboard.update(
      approved()[0],
      Msg.Loaded({ staged: [versions[1]!] }),
    );
    expect(model.publishing).toEqual([]);
    expect(model.published).toEqual([versions[0]!]);
    expect(model.notice).toEqual(
      Option.some(
        Dashboard.Notice.Success({
          text: "Published effect-idempotency@0.2.0.",
        }),
      ),
    );
    expect(Dashboard.awaitsNpm(model)).toBe(false);
  });

  test("a failed approval refreshes and explains", () => {
    const [model] = after(versions, ["return"]);
    const [next, command] = Dashboard.update(
      model,
      Msg.ApproveFailed({ reason: "409 Conflict" }),
    );
    expect(command).toEqual(Command.Refresh());
    expect(next.publishing).toEqual([]);
    expect(next.notice).toEqual(
      Option.some(Dashboard.Notice.Failure({ text: "409 Conflict" })),
    );
  });
});

/**
 * What can happen to the dashboard: a key press, or npm answering a refresh
 * with some of a small pool of versions, in any state.
 */
const Event = Schema.Union([
  Schema.TaggedStruct("Key", { key: Dashboard.Key }),
  Schema.TaggedStruct("Load", {
    staged: Schema.Array(
      Schema.Struct({
        version: Schema.Literals(["0.1.0", "0.2.0", "1.0.0"]),
        status: Schema.Literals(["staged", "validating", "rejected"]),
      }),
    ),
  }),
]);

/** Replays `events`, approving whatever the dashboard asks to, and checks every step. */
const holdsInvariants = (events: ReadonlyArray<typeof Event.Type>): boolean => {
  let [model] = Dashboard.init(packageName);
  for (const event of events) {
    const msg =
      event._tag === "Key"
        ? Msg.KeyPressed({ key: event.key })
        : Msg.Loaded({
            // npm lists a version once.
            staged: [
              ...new Map(
                event.staged.map((s) => [
                  s.version,
                  stagedVersion(s.version, s.status),
                ]),
              ).values(),
            ],
          });
    const before = model;
    let [next, command] = Dashboard.update(model, msg);
    if (command._tag === "Approve") {
      // Only a ready version, confirmed with a second enter, is approved.
      const confirmed = Option.getOrUndefined(before.confirming);
      if (confirmed?.id !== command.staged.id) return false;
      if (Dashboard.progressOf(before, command.staged) !== "ready")
        return false;
      [next, command] = Dashboard.update(
        next,
        Msg.Approved({ staged: command.staged }),
      );
    }
    model = next;
    const lastRow = Math.max(0, model.staged.length - 1);
    if (model.cursor < 0 || model.cursor > lastRow) return false;
    const published = new Set(model.published.map((s) => s.id));
    if (model.publishing.some((s) => published.has(s.id))) return false;
    if (command._tag === "Quit") break;
  }
  return true;
};

describe("Dashboard.update, for any events", () => {
  test("keeps the cursor on a row and approves only confirmed, ready versions", async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        Arbitrary.schema(Schema.Array(Event)),
        holdsInvariants,
        { runs: 500, seed: 1 },
      ),
    );
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
  });
});

describe("Dashboard.view", () => {
  test("shows the confirmation with what gets published", () => {
    const text = Dashboard.view(after(versions, ["return"])[0]);
    expect(text).toContain("Publish effect-idempotency@0.2.0?");
    expect(text).toContain("e406607c8ac3c7e5f5bdcfc7daf9512d7003d977");
    expect(text).toContain("2026-11-26 14:41 UTC by GitHub Actions");
  });

  test("says when nothing is staged", () => {
    expect(Dashboard.view(after([])[0])).toContain("Nothing is staged.");
  });
});
