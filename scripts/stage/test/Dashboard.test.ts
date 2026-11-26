import { describe, expect, test } from "bun:test";
import * as Dashboard from "../Dashboard.ts";
import { packageName, stagedVersion } from "./TestEnvironment.ts";

const { Msg } = Dashboard;

/** The dashboard after loading `staged` and pressing `keys`. */
const after = (
  staged: Parameters<typeof Msg.Loaded>[0]["staged"],
  keys: ReadonlyArray<string> = [],
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

const versions = [stagedVersion("0.1.0"), stagedVersion("0.2.0")];

describe("Dashboard.update", () => {
  test("starts by loading", () => {
    const [model, command] = Dashboard.init(packageName);
    expect(model.loading).toBe(true);
    expect(command._tag).toBe("Refresh");
  });

  test("moves the cursor within the list", () => {
    expect(after(versions, ["down"])[0].cursor).toBe(1);
    expect(after(versions, ["down", "down", "down"])[0].cursor).toBe(1);
    expect(after(versions, ["j", "k", "up"])[0].cursor).toBe(0);
  });

  test("enter on a ready version asks for confirmation", () => {
    const [model, command] = after(versions, ["down", "return"]);
    expect(model.confirming?.version).toBe("0.2.0");
    expect(command._tag).toBe("Wait");
  });

  test("enter on the confirmation approves", () => {
    const [, command] = after(versions, ["return", "return"]);
    expect(command).toEqual(
      Dashboard.Command.Approve({ staged: versions[0]! }),
    );
  });

  test("other keys on the confirmation do not approve", () => {
    const [model, command] = after(versions, ["return", "y", "x"]);
    expect(model.confirming?.version).toBe("0.1.0");
    expect(command._tag).toBe("Wait");
  });

  test("escape leaves the confirmation, then quits", () => {
    expect(after(versions, ["return", "escape"])[0].confirming).toBeUndefined();
    expect(after(versions, ["return", "escape", "escape"])[1]._tag).toBe(
      "Quit",
    );
  });

  test("enter on a version in review explains instead", () => {
    const [model] = after([stagedVersion("0.1.0", "validating")], ["return"]);
    expect(model.confirming).toBeUndefined();
    expect(model.notice?.text).toContain("still reviewing");
  });

  test("the next key press dismisses a notice", () => {
    const [model] = after(
      [stagedVersion("0.1.0", "validating")],
      ["return", "down"],
    );
    expect(model.notice).toBeUndefined();
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
    expect(command._tag).toBe("Refresh");
  });

  test("closed input quits", () => {
    expect(Dashboard.update(after(versions)[0], Msg.Closed())[1]._tag).toBe(
      "Quit",
    );
  });
});

describe("Dashboard.view", () => {
  test("shows the confirmation with what gets published", () => {
    const text = Dashboard.view(after(versions, ["return"])[0]);
    expect(text).toContain("Publish effect-idempotency@0.1.0?");
    expect(text).toContain("e406607c8ac3c7e5f5bdcfc7daf9512d7003d977");
    expect(text).toContain("2026-11-26 14:41 UTC by GitHub Actions");
  });

  test("says when nothing is staged", () => {
    expect(Dashboard.view(after([])[0])).toContain("Nothing is staged.");
  });
});
