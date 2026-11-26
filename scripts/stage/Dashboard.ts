/**
 * The interactive screen of `bun stage`, as plain data and functions: the
 * state on screen (`Model`), what can happen to it (`Msg`), how it changes
 * (`update`), and how it looks (`view`). `Cli.ts` runs it on a terminal.
 */
import { Data, Duration } from "effect";
import type { StagedVersion } from "./NpmStage.ts";

/** How often to check on the versions npm is still reviewing. */
export const reviewPollInterval = Duration.seconds(10);

export interface Notice {
  readonly tone: "info" | "success" | "error";
  readonly text: string;
}

export interface Model {
  readonly packageName: string;
  readonly staged: ReadonlyArray<StagedVersion>;
  /** The index of the highlighted version in `staged`. */
  readonly cursor: number;
  /** The version waiting for a second enter, on the confirmation screen. */
  readonly confirming: StagedVersion | undefined;
  readonly loading: boolean;
  readonly notice: Notice | undefined;
}

export type Msg = Data.TaggedEnum<{
  /** A key press, by name: "up", "return", "r". */
  KeyPressed: { readonly key: string };
  /** Time to check again on the versions npm is still reviewing. */
  Tick: {};
  Loaded: { readonly staged: ReadonlyArray<StagedVersion> };
  LoadFailed: { readonly reason: string };
  /** The terminal input ended, such as with ctrl-c. */
  Closed: {};
}>;
export const Msg = Data.taggedEnum<Msg>();

/** What the runner does after a message. */
export type Command = Data.TaggedEnum<{
  /** Wait for the next key press or tick. */
  Wait: {};
  Refresh: {};
  Approve: { readonly staged: StagedVersion };
  Quit: {};
}>;
export const Command = Data.taggedEnum<Command>();

/** The model after a message, and what the runner does next. */
export type Step = readonly [Model, Command];

export const init = (packageName: string, notice?: Notice): Step => [
  {
    packageName,
    staged: [],
    cursor: 0,
    confirming: undefined,
    loading: true,
    notice,
  },
  Command.Refresh(),
];

/** Whether npm still reviews a version, so the list is worth refreshing. */
export const awaitsReview = (model: Model): boolean =>
  model.staged.some((staged) => staged.inReview);

const refresh = (model: Model): Step => [
  { ...model, loading: true },
  Command.Refresh(),
];

const wait = (model: Model): Step => [model, Command.Wait()];

const clamp = (cursor: number, model: Model): number =>
  Math.max(0, Math.min(cursor, model.staged.length - 1));

const isEnter = (key: string) => key === "return" || key === "enter";

const onListKey = (model: Model, key: string): Step => {
  switch (key) {
    case "up":
    case "k":
      return wait({ ...model, cursor: clamp(model.cursor - 1, model) });
    case "down":
    case "j":
      return wait({ ...model, cursor: clamp(model.cursor + 1, model) });
    case "r":
      return refresh(model);
    case "q":
    case "escape":
      return [model, Command.Quit()];
  }
  if (!isEnter(key)) {
    return wait(model);
  }
  const selected = model.staged[model.cursor];
  if (selected === undefined) {
    return wait(model);
  }
  if (selected.inReview) {
    return wait({
      ...model,
      notice: {
        tone: "info",
        text: `npm is still reviewing ${selected.spec}. It can be published once the review passes.`,
      },
    });
  }
  return wait({ ...model, confirming: selected });
};

const onConfirmKey = (
  model: Model,
  confirming: StagedVersion,
  key: string,
): Step => {
  if (isEnter(key)) {
    return [model, Command.Approve({ staged: confirming })];
  }
  switch (key) {
    case "escape":
    case "backspace":
    case "q":
    case "n":
      return wait({ ...model, confirming: undefined });
  }
  return wait(model);
};

export const update = (model: Model, msg: Msg): Step =>
  Msg.$match(msg, {
    KeyPressed: ({ key }) => {
      // A notice answers the last key press, so the next one dismisses it.
      const next = { ...model, notice: undefined };
      return model.confirming === undefined
        ? onListKey(next, key)
        : onConfirmKey(next, model.confirming, key);
    },
    Tick: () => refresh(model),
    Loaded: ({ staged }) => {
      const next = { ...model, staged, loading: false };
      // The highlighted version can disappear, once published or rejected.
      return wait({ ...next, cursor: clamp(model.cursor, next) });
    },
    LoadFailed: ({ reason }) =>
      wait({
        ...model,
        loading: false,
        notice: { tone: "error", text: reason },
      }),
    Closed: (): Step => [model, Command.Quit()],
  });

const style =
  (open: number, close: number) =>
  (text: string): string =>
    `\x1b[${open}m${text}\x1b[${close}m`;
const bold = style(1, 22);
const dim = style(2, 22);
const red = style(31, 39);
const green = style(32, 39);
const yellow = style(33, 39);
const cyan = style(36, 39);

/** `2026-11-26T14:41:51.008Z` as `2026-11-26 14:41 UTC`. */
const formatDate = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : iso;

const viewNotice = (notice: Notice | undefined): Array<string> => {
  if (notice === undefined) return [];
  const tone = { info: yellow, success: green, error: red }[notice.tone];
  return ["", `  ${tone(notice.text)}`];
};

const viewList = (model: Model): Array<string> => {
  const header = `${bold(model.packageName)} ${dim("· staged on npm")}`;
  if (model.staged.length === 0) {
    return [
      header,
      "",
      model.loading
        ? dim("  Loading...")
        : `  Nothing is staged. The release workflow stages a version when the\n  "chore: version packages" pull request merges.`,
      ...viewNotice(model.notice),
      "",
      dim("  r refresh · q quit"),
    ];
  }
  const width = Math.max(...model.staged.map((s) => s.version.length));
  const rows = model.staged.map((staged, index) => {
    const selected = index === model.cursor;
    const pointer = selected ? cyan("›") : " ";
    const version = staged.version.padEnd(width);
    const status = staged.inReview
      ? yellow("◌ npm is reviewing   ")
      : green("● ready to publish   ");
    const details = dim(
      `${staged.tag} · staged ${formatDate(staged.createdAt)}${staged.actor ? ` by ${staged.actor}` : ""}`,
    );
    return `${pointer} ${selected ? bold(version) : version}  ${status}${details}`;
  });
  const footer = [
    "↑↓ move",
    "enter publish",
    "r refresh",
    "q quit",
    ...(model.loading
      ? ["refreshing..."]
      : awaitsReview(model)
        ? [`checking the review every ${Duration.format(reviewPollInterval)}`]
        : []),
  ].join(" · ");
  return [header, "", ...rows, ...viewNotice(model.notice), "", dim(footer)];
};

const viewConfirm = (staged: StagedVersion): Array<string> => [
  bold(`Publish ${staged.spec}?`),
  "",
  `  version  ${staged.version}`,
  `  tag      ${staged.tag}`,
  `  staged   ${formatDate(staged.createdAt)}${staged.actor ? ` by ${staged.actor}` : ""}`,
  ...(staged.shasum ? [`  shasum   ${staged.shasum}`] : []),
  "",
  `  Everyone who installs ${staged.packageName}@${staged.tag} gets this version.`,
  "  npm asks for two-factor authentication next.",
  "",
  dim(`enter publish · esc back`),
];

export const view = (model: Model): string =>
  (model.confirming === undefined
    ? viewList(model)
    : viewConfirm(model.confirming)
  ).join("\n");
