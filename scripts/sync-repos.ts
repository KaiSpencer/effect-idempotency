/**
 * Clones the source of libraries this package builds on into `repos/`, as
 * read-only reference for coding agents (see AGENTS.md). Each one is a shallow
 * clone of the release tag that matches the installed version, so it shows the
 * code that actually runs, tests and docs included.
 *
 * `repos/` is gitignored, and `.ignore` puts it back in reach of ripgrep, the
 * search most agents use. `bun install` runs this through `prepare`; it does
 * nothing in CI and, run that way, warns instead of failing when offline.
 */
import { $ } from "bun";

interface Repo {
  readonly name: string;
  readonly url: string;
  readonly tag: (version: string) => string;
}

const repos: ReadonlyArray<Repo> = [
  {
    name: "effect",
    url: "https://github.com/Effect-TS/effect.git",
    tag: (version) => `effect@${version}`,
  },
];

const installedVersion = async (name: string): Promise<string> => {
  const manifest: { version: string } = await Bun.file(
    `node_modules/${name}/package.json`,
  ).json();
  return manifest.version;
};

/** The tags on HEAD: Effect releases every package from one commit. */
const headTags = async (dir: string): Promise<ReadonlyArray<string>> => {
  const result = await $`git -C ${dir} tag --points-at HEAD`.nothrow().quiet();
  return result.exitCode === 0 ? result.text().split("\n").filter(Boolean) : [];
};

const sync = async (repo: Repo): Promise<void> => {
  const dir = `repos/${repo.name}`;
  const tag = repo.tag(await installedVersion(repo.name));
  const cloned = await Bun.file(`${dir}/.git/HEAD`).exists();
  const tags = cloned ? await headTags(dir) : [];

  if (tags.includes(tag)) {
    console.log(`${dir}: ${tag}, up to date`);
    return;
  }
  if (!cloned) {
    await $`git clone --quiet --depth 1 --branch ${tag} -c advice.detachedHead=false ${repo.url} ${dir}`.quiet();
  } else {
    await $`git -C ${dir} fetch --quiet --depth 1 origin tag ${tag}`.quiet();
    await $`git -C ${dir} -c advice.detachedHead=false checkout --quiet --force ${tag}`.quiet();
  }
  console.log(`${dir}: ${tag}`);
};

if (process.env.CI) {
  console.log("sync-repos: skipped in CI");
} else {
  const fromInstall = process.env.npm_lifecycle_event === "prepare";
  for (const repo of repos) {
    try {
      await sync(repo);
    } catch (error) {
      const message =
        error instanceof $.ShellError
          ? error.stderr.toString().trim()
          : String(error);
      console.warn(`sync-repos: could not sync repos/${repo.name}: ${message}`);
      if (!fromInstall) process.exitCode = 1;
    }
  }
}
