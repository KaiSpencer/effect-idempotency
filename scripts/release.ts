/**
 * Publishes the version in package.json when npm does not have it yet, then
 * creates the GitHub release and its tag.
 *
 * The release workflow runs this on every push to main that has no pending
 * changeset, so it must be safe to run again for a version already out.
 * Authentication is npm Trusted Publishing: the workflow's OIDC token, no
 * stored npm token.
 */
import { $ } from "bun";

const pkg = (await Bun.file("package.json").json()) as {
  name: string;
  version: string;
};

if (process.env.NPM_PUBLISH !== "true") {
  console.log(
    'The NPM_PUBLISH repository variable is not "true": nothing published.',
  );
  console.log("Set it once npm trusts this workflow. See CONTRIBUTING.md.");
  process.exit(0);
}

const lookup = await fetch(
  `https://registry.npmjs.org/${pkg.name}/${pkg.version}`,
);
if (lookup.ok) {
  console.log(
    `${pkg.name}@${pkg.version} is already on npm: nothing published.`,
  );
  process.exit(0);
}
if (lookup.status !== 404) {
  throw new Error(
    `The npm registry answered ${lookup.status} for ${pkg.name}@${pkg.version}.`,
  );
}

await $`npm publish`;
const tag = `v${pkg.version}`;
await $`gh release create ${tag} --title ${tag} --generate-notes --target ${process.env.GITHUB_SHA ?? "main"}`;
