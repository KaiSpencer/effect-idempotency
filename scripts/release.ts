/**
 * Stages the version in package.json on npm when npm does not have it yet,
 * then creates the GitHub release and its tag.
 *
 * Nothing goes live from here. npm trusts this workflow for
 * `npm stage publish` only: the staged version waits until a maintainer
 * approves it with two-factor authentication (`npm stage approve`).
 * Authentication is npm Trusted Publishing: the workflow's OIDC token, no
 * stored npm token.
 *
 * The release workflow runs this on every push to main that has no pending
 * changeset, so it must be safe to run again. The GitHub release marks a
 * version as staged.
 */
import { $ } from "bun";

const pkg = (await Bun.file("package.json").json()) as {
  name: string;
  version: string;
};
const tag = `v${pkg.version}`;

if (process.env.NPM_PUBLISH !== "true") {
  console.log(
    'The NPM_PUBLISH repository variable is not "true": nothing staged.',
  );
  process.exit(0);
}

const lookup = await fetch(
  `https://registry.npmjs.org/${pkg.name}/${pkg.version}`,
);
if (lookup.ok) {
  console.log(`${pkg.name}@${pkg.version} is already on npm: nothing staged.`);
  process.exit(0);
}
if (lookup.status !== 404) {
  throw new Error(
    `The npm registry answered ${lookup.status} for ${pkg.name}@${pkg.version}.`,
  );
}

const release = await $`gh release view ${tag}`.nothrow().quiet();
if (release.exitCode === 0) {
  console.log(
    `${pkg.name}@${pkg.version} is staged and waits for approval: npm stage list ${pkg.name}`,
  );
  process.exit(0);
}

await $`bun run build`;
await $`npm stage publish .`;
await $`gh release create ${tag} --title ${tag} --generate-notes --target ${process.env.GITHUB_SHA ?? "main"}`;
console.log(
  `Staged ${pkg.name}@${pkg.version}. Approve it: npm stage list ${pkg.name}, then npm stage approve <stage-id>.`,
);
