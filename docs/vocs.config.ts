import { fileURLToPath } from "node:url";
import { defineConfig, McpSource } from "vocs/config";
import { remarkPlainCode } from "./src/markdownOutput.ts";

const repo = "KaiSpencer/effect-idempotency";

// Vercel names the site's address while it builds: the production domain for
// a production build, and the deployment's own for a preview. Without one, as
// on a local build, there is no sitemap and links stay relative.
const baseUrl =
  process.env.VERCEL_ENV === "production"
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL
    : process.env.VERCEL_URL;

export default defineConfig({
  title: "effect-idempotency",
  description:
    "Idempotency-Key handling for Effect's HttpApi: a server middleware that makes a retried request return the first response.",
  baseUrl,

  // Pages are built as static files. The MCP server and the social preview
  // images are the only parts that run on a server.
  renderStrategy: "partial-static",

  // Agents read these pages as Markdown: `/llms.txt`, `/llms-full.txt`, any
  // page with `.md` added, and the MCP server at `/api/mcp`. A page whose
  // Markdown would come out broken fails the build.
  markdown: {
    output: { validation: "fail" },
    outputRemarkPlugins: [remarkPlainCode],
  },
  mcp: {
    enabled: true,
    // Lets an agent read the library's source and tests next to the pages.
    // Set `GITHUB_TOKEN` where the site runs for GitHub's higher rate limit.
    sources: [
      McpSource.github({
        name: "effect-idempotency",
        repo,
        paths: ["src", "test"],
      }),
    ],
  },

  // Every `ts twoslash` block is compiled against the library's source, with
  // the options the library itself is checked with, and an error fails the
  // build. `effect` and its drivers resolve from the repository root, so the
  // examples are checked against the version the library is tested with.
  twoslash: {
    twoslashOptions: {
      compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        paths: {
          "effect-idempotency": [
            fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          ],
        },
      },
    },
  },

  editLink: {
    link: `https://github.com/${repo}/edit/main/docs/src/pages/:path`,
  },
  socials: [{ icon: "github", link: `https://github.com/${repo}` }],
  topNav: [
    { text: "Guide", link: "/getting-started", match: isGuide },
    { text: "Reference", link: "/reference/idempotency", match: "/reference" },
    { text: "AI agents", link: "/agents" },
    {
      text: "Links",
      items: [
        {
          text: "Changelog",
          link: `https://github.com/${repo}/blob/main/CHANGELOG.md`,
        },
        {
          text: "Contributing",
          link: `https://github.com/${repo}/blob/main/CONTRIBUTING.md`,
        },
      ],
    },
  ],
  sidebar: [
    { text: "Introduction", link: "/" },
    { text: "Getting started", link: "/getting-started" },
    {
      text: "Behaviour",
      items: [
        { text: "How a request is answered", link: "/behaviour/requests" },
        { text: "The key", link: "/behaviour/key" },
        { text: "Scope", link: "/behaviour/scope" },
        { text: "What is stored", link: "/behaviour/stored-responses" },
        { text: "Disconnects and failures", link: "/behaviour/failures" },
        { text: "Limits", link: "/behaviour/limits" },
      ],
    },
    {
      text: "Stores",
      items: [
        { text: "Choosing a store", link: "/stores" },
        { text: "Memory", link: "/stores/memory" },
        { text: "SQL", link: "/stores/sql" },
        { text: "Writing a store", link: "/stores/custom" },
      ],
    },
    { text: "Errors", link: "/errors" },
    {
      text: "Reference",
      items: [
        { text: "Idempotency", link: "/reference/idempotency" },
        { text: "IdempotencyKey", link: "/reference/idempotency-key" },
        { text: "IdempotencyStore", link: "/reference/idempotency-store" },
        { text: "IdempotencyError", link: "/reference/idempotency-error" },
      ],
    },
    { text: "AI agents", link: "/agents" },
    { text: "Roadmap", link: "/roadmap" },
  ],
});

function isGuide(path: string | undefined): boolean {
  return (
    path !== undefined &&
    ["/getting-started", "/behaviour", "/stores", "/errors"].some((prefix) =>
      path.startsWith(prefix),
    )
  );
}
