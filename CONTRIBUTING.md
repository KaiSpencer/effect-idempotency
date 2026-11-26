# Contributing

The repository runs on [Bun](https://bun.sh) alone: package manager, test
runner, formatter, linter, typechecker, and bundler. There is no `typescript`
dependency.

It needs a canary build: `bun lint` and `bun build --dts` are not in a Bun
release yet. The exact build is pinned in `package.json` (`packageManager`),
and CI installs that version from npm, where canary versions are immutable.
Install the same one with `npm install --global bun@<that version>`. Move the
pin to 1.4.6 once it is released.

```bash
bun install
bun run verify    # format check, lint, typecheck, tests
bun fmt           # format
bun lint --fix    # lint and apply fixes
bun check         # typecheck
bun test          # tests
bun run build     # bundle src/index.ts into dist/, with declarations
```

Relative imports carry the `.ts` extension. `tsconfig.src.json` typechecks
`src/` without Bun's types, so the library cannot lean on a Bun global.

## Tests

`bun test` runs everything. The tests come in four kinds:

- **Unit** (`test/*.test.ts`, `test/internal`): the pure parts, one module
  per file.
- **Store contract** (`test/support/storeContract.ts`): what every
  `IdempotencyStore` must do. A new store's test file calls `storeContract`
  with its layer.
- **Pipeline** (`test/Idempotency.test.ts`): the middleware through the whole
  `HttpApi` pipeline with a typed client and no socket, under the test clock.
- **End to end** (`test/e2e`): what a client sees over a real connection.
  `scenarios.ts` only speaks HTTP, through Effect's `HttpClient`. Each way of
  serving the fixture API has a test file that passes it a layer, which starts
  a server and provides a client pointed at it, so a new setup is one small
  file.

Effect tests use `test/support/EffectTest.ts`, a port of `@effect/vitest` to
`bun test`: `it.effect` runs an Effect with a scope and a `TestClock`,
`it.live` with the real clock, and `layer` shares one layer between the tests
of a block.

`test/fixtures/Payments.ts` is the API the pipeline and end-to-end tests run
against. Its control endpoints hold a charge open and count the charges, so a
test can ask "did the handler run twice?" over HTTP.

## Changes

`main` is protected: every change arrives through a pull request, and the
`check` job of `ci.yml` must pass on it. A workflow run on a pull request from
a fork waits for a maintainer's approval.

A change users can see adds a changeset: run `bun run changeset` and commit
the file. On `0.x`, a feature or a fix is a `patch` and a breaking change is a
`minor`.

## Releases

1. A push to `main` with pending changesets opens or updates a pull request
   named "chore: version packages", which bumps the version and writes
   `CHANGELOG.md`. GitHub holds that pull request's own checks for approval,
   because a workflow opened it, so the release job dispatches `ci.yml` on
   its branch instead, which reports the `check` status the merge needs.
   Ignore the "workflow awaiting approval" notice.
2. Merging that pull request runs `scripts/release.ts`: it stages the new
   version on npm and creates the GitHub release and tag.
3. A maintainer approves the staged version with two-factor authentication:
   `npm stage list effect-idempotency`, then `npm stage approve <stage-id>`.
   Only then is the version installable.

No npm token is stored anywhere. The release job proves who it is to npm with
a short-lived OIDC token ([Trusted Publishing](https://docs.npmjs.com/trusted-publishers)),
and npm trusts it for `npm stage publish` only, so nothing a workflow does
reaches users without a maintainer's approval.

- Dependency install scripts do not run: Bun only runs them for packages
  listed in `trustedDependencies`, and none are.
- `bunfig.toml` refuses a dependency version published less than 3 days ago.
- Every action is pinned to a commit SHA; Dependabot proposes the updates.
- The release job runs in the `npm` environment, which deploys from `main`
  only.
- The package requires two-factor authentication to publish and accepts no
  token that bypasses it.

To reject a staged version, run `npm stage reject <stage-id>` and delete its
GitHub release and tag, which is what marks the version as staged.

The `NPM_PUBLISH` repository variable turns staging on. Unset it
(`gh variable delete NPM_PUBLISH`) to stop the release job from staging.
