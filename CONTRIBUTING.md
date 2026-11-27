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
bun run docs      # the documentation site, at http://localhost:5173
bun stage         # publish a version the release workflow staged on npm
```

`bun install` also clones the Effect source, at the tag of the installed
version, into `repos/effect`, as reference for coding agents (see
[AGENTS.md](AGENTS.md)). It is gitignored, skipped in CI, and only warns when
offline. Run `bun run repos:sync` to update it after changing the Effect
version.

Relative imports carry the `.ts` extension. `tsconfig.src.json` typechecks
`src/` without Bun's types, so the library cannot lean on a Bun global.

Nothing is left as a warning. `bun lint` fails on a warning as it does on an
error (`maxWarnings = 0` in `bunfig.toml`), and the compiler options make
unused code, unreachable code and missing returns errors. There is no `any`,
written or let in from an untyped value: decode outside data with `Schema`
instead. When a rule is wrong somewhere, disable it on that line with a comment
that says why, or turn it off in `bunfig.toml`. The lint type-checks the
documentation site as well, so `verify` installs the site's packages first.

## Tests

`bun test` runs everything. The tests come in five kinds:

- **Unit** (`test/*.test.ts`, `test/internal`): the pure parts, one module
  per file.
- **Store contract** (`test/support/storeContract.ts`): what every
  `IdempotencyStore` must do. A new store's test file calls `storeContract`
  with its layer. Its last test is a **model check**
  (`test/support/storeModel.ts`): random sequences of claims, completions,
  releases and passing time must get the same answers from the store as from
  the memory store, and a sequence that does not is shrunk to a short one.
- **SQL store** (`test/IdempotencyStoreSql.test.ts`): the contract, and then
  what only a store in a database can get wrong, each on every database of
  `test/support/sqlBackends.ts`.
- **Pipeline** (`test/Idempotency.test.ts`): the middleware through the whole
  `HttpApi` pipeline with a typed client and no socket, under the test clock.
- **End to end** (`test/e2e`): what a client sees over a real connection.
  `scenarios.ts` only speaks HTTP, through Effect's `HttpClient`. Each way of
  serving the fixture API has a test file that passes it a layer, which starts
  a server and provides a client pointed at it, so a new setup is one small
  file. `bunServeSql.test.ts` also runs two servers on one database.

### Databases

The SQL store is tested on three databases. Two run inside `bun test` and
need nothing: SQLite, and PGlite, which is PostgreSQL compiled to WebAssembly.
The third is a PostgreSQL server, the only one of the three with more than one
connection, so the only one where two statements run at the same time. Its
tests run when `TEST_POSTGRES_URL` names a server, and are reported as skipped
otherwise:

```bash
docker run --rm -d --name effect-idempotency-postgres \
  -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:54329:5432 postgres:17-alpine
TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres bun test
docker stop effect-idempotency-postgres
```

Each test works in a schema of its own, which it drops, so the database can
be any one you do not mind schemas named `test_...` appearing in. CI runs a
server for the `check` job, and there a missing `TEST_POSTGRES_URL` fails the
run.

A test under the test clock should not move it by more than a few weeks at
once: a database client has timers of its own, and the test clock runs every
one of them for each interval it skips.

Effect tests use `test/support/EffectTest.ts`, a port of `@effect/vitest` to
`bun test`: `it.effect` runs an Effect with a scope and a `TestClock`,
`it.live` with the real clock, and `layer` shares one layer between the tests
of a block.

`test/fixtures/Payments.ts` is the API the pipeline and end-to-end tests run
against. Its control endpoints hold a charge open and count the charges, so a
test can ask "did the handler run twice?" over HTTP.

## Documentation

The documentation site is in `docs/`, built with [Vocs](https://vocs.dev). It
is a package of its own, with its own lockfile, so that React and Vite stay
out of the library's install. Its examples import `effect` from the
repository root, so run `bun install` there first. These run from the root,
and install the site's own dependencies when they are missing:

```bash
bun run docs           # the site, at http://localhost:5173
bun run docs:check     # typecheck the config and the snippets
bun run docs:build     # build it, as CI does
```

- **Pages** are MDX files in `docs/src/pages`. A new page also goes in the
  `sidebar` of `docs/vocs.config.ts`.
- **Examples** are fenced as `ts twoslash`. The build compiles each against
  `src/`, with the compiler options the library is checked with, and fails on
  a type error. So a change to the library that breaks an example fails the
  `docs` job of `ci.yml`.
- **Shared code** for the examples is in `docs/src/snippets`. A block pulls
  it in with `// [!include ~/snippets/Api.ts]`, and hides what is above
  `// ---cut---`.
- **Agents** read the same pages as Markdown: `/llms.txt`, `/llms-full.txt`,
  any page with `.md` added, and an MCP server at `/api/mcp`.
  `docs/src/markdownOutput.ts` makes the code in that Markdown read as the
  page shows it. Start a page with `# Title [One-line summary]`: the summary
  is its entry in `/llms.txt`.

A change users can see updates the pages that describe it.

### Deployment

The site is made for [Vercel](https://vercel.com), with the project's Root
Directory set to `docs`. `docs/vercel.json` holds the install and build
commands: the install also installs the repository root, where the examples
find `effect`. Vocs detects Vercel and builds the pages as static files and
the MCP server as a function.

The site's address comes from Vercel's own environment variables, so there is
none to set. `GITHUB_TOKEN` is optional: with it, the MCP server reads the
source from GitHub at the higher rate limit.

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
3. A maintainer publishes the staged version with two-factor
   authentication: run `bun stage`, pick the version, and press enter twice.
   It shows what is staged and checks on npm's automated review until the
   version is ready. Only then is the version installable.

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
