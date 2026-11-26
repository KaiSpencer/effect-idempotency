# Contributing

The repository runs on [Bun](https://bun.sh): package manager, test runner,
and script runner. The version is pinned in `package.json` (`packageManager`).

```bash
bun install
bun run verify    # format check, lint, typecheck, tests
bun fmt           # format
bun lint --fix    # lint and apply fixes
bun check         # typecheck
bun test          # tests
bun run build     # emit dist/ with tsc
```

`bun lint` needs Bun 1.4.6, which is a canary build today
(`bun upgrade --canary`). The released 1.4.5 runs everything else. `tsc` only
writes `dist/`; once `bun build --dts` is in a release it can go too.

Relative imports carry the `.ts` extension; the build rewrites them to `.js`.

## Changes

A change users can see adds a changeset: run `bun run changeset` and commit
the file. On `0.x`, a feature or a fix is a `patch` and a breaking change is a
`minor`.

## Releases

1. A push to `main` with pending changesets opens or updates a pull request
   named "chore: version packages", which bumps the version and writes
   `CHANGELOG.md`.
2. Merging that pull request runs `scripts/release.ts`: it publishes the new
   version to npm and creates the GitHub release and tag.

No npm token is stored anywhere. The release job proves who it is to npm with
a short-lived OIDC token ([Trusted Publishing](https://docs.npmjs.com/trusted-publishers)),
and npm attaches provenance to the published version.

- Dependency install scripts do not run: Bun only runs them for packages
  listed in `trustedDependencies`, and none are.
- `bunfig.toml` refuses a dependency version published less than 3 days ago.
- Every action is pinned to a commit SHA; Dependabot proposes the updates.
- The release job runs in the `npm` environment, which deploys from `main`
  only.

### One-time setup

npm can only trust a workflow for a package that exists, so the first version
is published by hand:

1. `npm login`, then `npm publish` in a clean checkout of `main`. This puts
   `0.0.0` on npm.
2. On npmjs.com, open the package's Settings, then Trusted Publisher, and add
   GitHub Actions with owner `KaiSpencer`, repository `effect-idempotency`,
   workflow `release.yml`, and environment `npm`.
3. In the same settings, set publishing access to require two-factor
   authentication and disallow tokens.
4. `gh variable set NPM_PUBLISH --body true`. Until this variable is set, the
   release job opens version pull requests and publishes nothing.
