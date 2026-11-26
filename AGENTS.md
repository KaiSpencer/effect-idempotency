# Agent guide

Setup, commands, and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Vendored repositories

`repos/` holds the source of libraries this package builds on, as reference
material. `bun install` clones them (or run `bun run repos:sync`), each at the
release tag of the installed version, so they match the code that runs. They
are gitignored but searchable.

- Treat `repos/` as read-only. Do not edit it, and do not import from it:
  code imports from the normal package dependencies.
- Prefer patterns, examples, and APIs from the vendored source over memory,
  generated guesses, or web search results.

### Effect

- Before writing Effect code, read `repos/effect/LLMS.md`.
- Treat `repos/effect/` as the source of truth for idiomatic usage, module
  structure, and API design. Useful places:
  - `repos/effect/packages/effect/src/unstable/http-api/`: `HttpApi`, its
    middleware, and its client.
  - `repos/effect/packages/effect/src/unstable/http/`: the HTTP server and
    client underneath.
  - `repos/effect/ai-docs/src/`: worked examples, by topic.
  - `repos/effect/packages/*/test/`: how a module is meant to be used.
