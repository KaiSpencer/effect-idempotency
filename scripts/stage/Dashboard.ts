/**
 * The interactive screen of `bun stage`, as plain data and functions: the
 * state on screen (`Model`), what can happen to it (`Msg`), how it changes
 * (`update`), and how it looks (`view`). `Cli.ts` runs it on a terminal.
 */
import {
  Array as Arr,
  Data,
  Duration,
  Match,
  Number as Num,
  Option,
  Schema,
  SemVer,
} from "effect";
import type { PackageName, StagedVersion } from "./StagedVersion.ts";

/** The payload of a message or command that carries nothing. */
type NoFields = Record<never, never>;

/** How often to check on npm while it reviews or publishes a version. */
export const pollInterval = Duration.seconds(5);

/**
 * The keys the dashboard answers, by the name the terminal gives them. Any
 * other key press does nothing, so it never reaches `update`.
 */
export const Key = Schema.Literals([
  "up",
  "down",
  "k",
  "j",
  "return",
  "enter",
  "escape",
  "backspace",
  "n",
  "r",
  "q",
]);
export type Key = typeof Key.Type;

/** A line under the list that answers what just happened. */
export type Notice = Data.TaggedEnum<{
  Info: { readonly text: string };
  Success: { readonly text: string };
  Failure: { readonly text: string };
}>;
export const Notice = Data.taggedEnum<Notice>();

export interface Model {
  readonly packageName: PackageName;
  /** Newest version first, as `NpmStage.list` returns them. */
  readonly staged: ReadonlyArray<StagedVersion>;
  /** The index of the highlighted version in `staged`. */
  readonly cursor: number;
  /** The version waiting for a second enter, on the confirmation screen. */
  readonly confirming: Option.Option<StagedVersion>;
  readonly loading: boolean;
  readonly notice: Option.Option<Notice>;
  /** Versions approved here that npm has not finished publishing. */
  readonly publishing: ReadonlyArray<StagedVersion>;
  /** Versions approved here that npm has published. */
  readonly published: ReadonlyArray<StagedVersion>;
}

export type Msg = Data.TaggedEnum<{
  KeyPressed: { readonly key: Key };
  /** Time to check again on what npm is reviewing or publishing. */
  Tick: NoFields;
  Loaded: { readonly staged: ReadonlyArray<StagedVersion> };
  LoadFailed: { readonly reason: string };
  /** npm accepted the approval, and publishes the version. */
  Approved: { readonly staged: StagedVersion };
  ApproveFailed: { readonly reason: string };
  /** The terminal input ended, such as with ctrl-c. */
  Closed: NoFields;
}>;
export const Msg = Data.taggedEnum<Msg>();

/** What the runner does after a message. */
export type Command = Data.TaggedEnum<{
  /** Wait for the next key press or tick. */
  Wait: NoFields;
  Refresh: NoFields;
  Approve: { readonly staged: StagedVersion };
  Quit: NoFields;
}>;
export const Command = Data.taggedEnum<Command>();

/** The model after a message, and what the runner does next. */
export type Step = readonly [Model, Command];

export const init = (packageName: PackageName): Step => [
  {
    packageName,
    staged: [],
    cursor: 0,
    confirming: Option.none(),
    loading: true,
    notice: Option.none(),
    publishing: [],
    published: [],
  },
  Command.Refresh(),
];

/** Where a staged version stands, as far as publishing it goes. */
export type Progress = "ready" | "reviewing" | "publishing" | "other";

const sameStage = (self: StagedVersion, that: StagedVersion) =>
  self.id === that.id;

export const progressOf = (model: Model, staged: StagedVersion): Progress =>
  Arr.containsWith(sameStage)(model.publishing, staged)
    ? "publishing"
    : staged.isReady
      ? "ready"
      : staged.inReview
        ? "reviewing"
        : "other";

/**
 * Whether npm is still working on a version, reviewing or publishing it, so
 * the list is worth checking again by itself.
 */
export const awaitsNpm = (model: Model): boolean =>
  Arr.isReadonlyArrayNonEmpty(model.publishing) ||
  model.staged.some((staged) => progressOf(model, staged) !== "ready");

const refresh = (model: Model): Step => [
  { ...model, loading: true },
  Command.Refresh(),
];

const wait = (model: Model): Step => [model, Command.Wait()];

const withNotice = (model: Model, notice: Notice): Model => ({
  ...model,
  notice: Option.some(notice),
});

/** Keeps the cursor on a row, as the list grows and shrinks. */
const clampCursor = (model: Model, cursor: number): Model => ({
  ...model,
  cursor: Num.clamp(cursor, {
    minimum: 0,
    maximum: Math.max(0, model.staged.length - 1),
  }),
});

/** Enter on a row: confirm a ready version, or say why it cannot be. */
const select = (model: Model): Step =>
  Option.match(Arr.get(model.staged, model.cursor), {
    onNone: () => wait(model),
    onSome: (staged) =>
      Match.value(progressOf(model, staged)).pipe(
        Match.when("ready", () =>
          wait({ ...model, confirming: Option.some(staged) }),
        ),
        Match.when("reviewing", () =>
          wait(
            withNotice(
              model,
              Notice.Info({
                text: `npm is still reviewing ${staged.spec}. It can be published once the review passes.`,
              }),
            ),
          ),
        ),
        Match.when("publishing", () =>
          wait(
            withNotice(
              model,
              Notice.Info({ text: `npm is publishing ${staged.spec}.` }),
            ),
          ),
        ),
        Match.when("other", () =>
          wait(
            withNotice(
              model,
              Notice.Info({
                text: `${staged.spec} is ${staged.status} on npm, so it cannot be published from here.`,
              }),
            ),
          ),
        ),
        Match.exhaustive,
      ),
  });

const onListKey = (model: Model, key: Key): Step =>
  Match.value(key).pipe(
    Match.when(Match.is("up", "k"), () =>
      wait(clampCursor(model, model.cursor - 1)),
    ),
    Match.when(Match.is("down", "j"), () =>
      wait(clampCursor(model, model.cursor + 1)),
    ),
    Match.when(Match.is("return", "enter"), () => select(model)),
    Match.when("r", () => refresh(model)),
    Match.when(Match.is("q", "escape"), (): Step => [model, Command.Quit()]),
    Match.orElse(() => wait(model)),
  );

const onConfirmKey = (
  model: Model,
  confirming: StagedVersion,
  key: Key,
): Step =>
  Match.value(key).pipe(
    Match.when(Match.is("return", "enter"), (): Step => [
      model,
      Command.Approve({ staged: confirming }),
    ]),
    Match.when(Match.is("escape", "backspace", "q", "n"), () =>
      wait({ ...model, confirming: Option.none() }),
    ),
    Match.orElse(() => wait(model)),
  );

/** The loaded list, settling which versions npm has published since. */
const onLoaded = (model: Model, staged: ReadonlyArray<StagedVersion>): Step => {
  // npm has published an approved version once it leaves the list.
  const done = Arr.differenceWith(sameStage)(model.publishing, staged);
  const publishing = Arr.intersectionWith(sameStage)(model.publishing, staged);
  const next: Model = {
    ...model,
    staged,
    loading: false,
    publishing,
    published: [...model.published, ...done],
    notice: Arr.isReadonlyArrayNonEmpty(done)
      ? Option.some(
          Notice.Success({
            text: `Published ${done.map((p) => p.spec).join(", ")}.`,
          }),
        )
      : model.notice,
  };
  // The highlighted version can disappear, once published or rejected.
  return wait(clampCursor(next, model.cursor));
};

export const update = (model: Model, msg: Msg): Step =>
  Msg.$match(msg, {
    KeyPressed: ({ key }) => {
      // A notice answers the last key press, so the next one dismisses it.
      const next: Model = { ...model, notice: Option.none() };
      return Option.match(model.confirming, {
        onNone: () => onListKey(next, key),
        onSome: (confirming) => onConfirmKey(next, confirming, key),
      });
    },
    Tick: () => refresh(model),
    Loaded: ({ staged }) => onLoaded(model, staged),
    LoadFailed: ({ reason }) =>
      wait(
        withNotice(
          { ...model, loading: false },
          Notice.Failure({ text: reason }),
        ),
      ),
    Approved: ({ staged }) =>
      refresh(
        withNotice(
          {
            ...model,
            confirming: Option.none(),
            publishing: [...model.publishing, staged],
          },
          Notice.Info({ text: `npm is publishing ${staged.spec}...` }),
        ),
      ),
    ApproveFailed: ({ reason }) =>
      refresh(
        withNotice(
          { ...model, confirming: Option.none() },
          Notice.Failure({ text: reason }),
        ),
      ),
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

const viewNotice = (notice: Option.Option<Notice>): Array<string> =>
  Option.match(notice, {
    onNone: () => [],
    onSome: (notice) => [
      "",
      `  ${Notice.$match(notice, {
        Info: ({ text }) => yellow(text),
        Success: ({ text }) => green(text),
        Failure: ({ text }) => red(text),
      })}`,
    ],
  });

/** The progress column, padded to line up before it is colored. */
const viewProgress = (model: Model, staged: StagedVersion): string => {
  const [color, label] = Match.value(progressOf(model, staged)).pipe(
    Match.when("ready", () => [green, "● ready to publish"] as const),
    Match.when("reviewing", () => [yellow, "◌ npm is reviewing"] as const),
    Match.when("publishing", () => [yellow, "◌ publishing"] as const),
    Match.when("other", () => [yellow, `◌ ${staged.status}`] as const),
    Match.exhaustive,
  );
  return color(label.padEnd(20));
};

const viewList = (model: Model): Array<string> => {
  const header = `${bold(model.packageName)} ${dim("· staged on npm")}`;
  if (!Arr.isReadonlyArrayNonEmpty(model.staged)) {
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
  const versions = model.staged.map((staged) => SemVer.format(staged.version));
  const width = Math.max(...versions.map((version) => version.length));
  const rows = model.staged.map((staged, index) => {
    const selected = index === model.cursor;
    const version = (versions[index] ?? "").padEnd(width);
    const pointer = selected ? cyan("›") : " ";
    return `${pointer} ${[
      selected ? bold(version) : version,
      viewProgress(model, staged),
      dim(`${staged.tag} · staged ${staged.stagedBy}`),
    ].join("  ")}`;
  });
  const footer = [
    "↑↓ move",
    "enter publish",
    "r refresh",
    "q quit",
    ...(model.loading
      ? ["refreshing..."]
      : awaitsNpm(model)
        ? [`checking npm every ${Duration.format(pollInterval)}`]
        : []),
  ].join(" · ");
  return [header, "", ...rows, ...viewNotice(model.notice), "", dim(footer)];
};

const viewConfirm = (staged: StagedVersion): Array<string> => [
  bold(`Publish ${staged.spec}?`),
  "",
  `  version  ${SemVer.format(staged.version)}`,
  `  tag      ${staged.tag}`,
  `  staged   ${staged.stagedBy}`,
  ...Option.match(staged.shasum, {
    onNone: () => [],
    onSome: (shasum) => [`  shasum   ${shasum}`],
  }),
  "",
  `  Everyone who installs ${staged.packageName}@${staged.tag} gets this version.`,
  "  npm asks for two-factor authentication next.",
  "",
  dim("enter publish · esc back"),
];

export const view = (model: Model): string =>
  Option.match(model.confirming, {
    onNone: () => viewList(model),
    onSome: viewConfirm,
  }).join("\n");
