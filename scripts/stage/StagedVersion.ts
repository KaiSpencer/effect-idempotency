/**
 * What `npm stage` reports about a staged version, decoded and branded so a
 * stage id, a package name, or a version cannot be passed where another one
 * belongs.
 */
import { DateTime, Option, Order, Schema, SemVer } from "effect";

/** The id npm gives a staged version, for `npm stage approve <id>`. */
export const StageId = Schema.NonEmptyString.pipe(Schema.brand("StageId"));
export type StageId = typeof StageId.Type;

/**
 * An npm package name, scoped or not, following npm's naming rules.
 * https://docs.npmjs.com/cli/configuring-npm/package-json#name
 */
export const PackageName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(214),
    Schema.isPattern(
      /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
      {
        message: "Expected an npm package name",
      },
    ),
  ),
  Schema.brand("PackageName"),
);
export type PackageName = typeof PackageName.Type;

/** A dist-tag, such as `latest`, that installs point at. */
export const DistTag = Schema.NonEmptyString.pipe(Schema.brand("DistTag"));
export type DistTag = typeof DistTag.Type;

/** The SHA-1 of the package tarball. */
export const Shasum = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{40}$/, { message: "Expected a SHA-1 hash" }),
  ),
  Schema.brand("Shasum"),
);
export type Shasum = typeof Shasum.Type;

/**
 * Where a staged version stands on npm. npm documents no fixed set, so any
 * value decodes; `staged` and `validating` are the ones this script acts on.
 */
export const StageStatus = Schema.NonEmptyString.pipe(
  Schema.brand("StageStatus"),
);
export type StageStatus = typeof StageStatus.Type;

/** npm's automated review passed: the version can be approved. */
const ready = "staged";
/** npm's automated review runs: npm refuses an approval until it ends. */
const reviewing = "validating";

/** A version waiting on npm for a maintainer's approval. */
export class StagedVersion extends Schema.Class<StagedVersion>("StagedVersion")(
  {
    id: StageId,
    packageName: PackageName,
    version: Schema.SemVerFromString,
    tag: DistTag,
    status: StageStatus,
    createdAt: Schema.DateTimeUtcFromString,
    actor: Schema.OptionFromOptionalKey(Schema.String),
    shasum: Schema.OptionFromOptionalKey(Shasum),
  },
) {
  /** `effect-idempotency@0.1.0` */
  get spec(): string {
    return `${this.packageName}@${SemVer.format(this.version)}`;
  }

  /** Where the version lives on npmjs.com once published. */
  get url(): URL {
    return new URL(
      `https://www.npmjs.com/package/${this.packageName}/v/${SemVer.format(this.version)}`,
    );
  }

  get isReady(): boolean {
    return this.status === ready;
  }

  get inReview(): boolean {
    return this.status === reviewing;
  }

  /** `2026-11-26 14:41 UTC by GitHub Actions` */
  get stagedBy(): string {
    const at = DateTime.toPartsUtc(this.createdAt);
    const time = [at.hour, at.minute]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    return `${DateTime.formatIsoDateUtc(this.createdAt)} ${time} UTC${Option.match(
      this.actor,
      { onNone: () => "", onSome: (actor) => ` by ${actor}` },
    )}`;
  }
}

/** Newest version first, the one a maintainer most likely wants. */
export const newestFirst: Order.Order<StagedVersion> = Order.flip(
  Order.mapInput(SemVer.Order, (staged: StagedVersion) => staged.version),
);
