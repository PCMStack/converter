# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

This package converts Pro Cycling Manager CDB binary database files to and from SQLite using TypeScript.

- Public API lives in [README.md](README.md) and is re-exported from [src/index.ts](src/index.ts).
- Main conversion entrypoints are [src/cdbToSql.ts](src/cdbToSql.ts) and [src/sqlToCdb.ts](src/sqlToCdb.ts).
- Low-level binary format handling lives in [src/reader.ts](src/reader.ts), [src/writer.ts](src/writer.ts), [src/types.ts](src/types.ts), and [src/tableMetadata.ts](src/tableMetadata.ts).
- Compression helpers live in [src/compression.ts](src/compression.ts).

### Terminology

Two words, deliberately not interchangeable (same meanings as in `pcm-mcp`):

- **database** — a `.cdb` file. Cyanide's binary database format, and what this
  library exists to read and write. It may be a player save, an official release
  or a community update; nothing in the conversion path cares which. Here it is
  always handled as a *buffer*, never a path: the public API takes `cdbBuffer` /
  returns `Uint8Array`, and only the CLI in [src/cli.ts](src/cli.ts) touches the
  filesystem. The format internals live in [src/reader.ts](src/reader.ts),
  [src/writer.ts](src/writer.ts), [src/compression.ts](src/compression.ts) and
  [src/tableMetadata.ts](src/tableMetadata.ts).
- **save** — a `.cdb` the *game itself wrote* as the player played, as opposed to
  an official release or a community update. This repository has no notion of
  save discovery, so the word belongs only where provenance is the actual point:
  the reverse-engineering notes in [src/keyInference.ts](src/keyInference.ts) and
  [src/tableMetadata.ts](src/tableMetadata.ts) ("observed in real saves"). Never
  use it as a generic name for the input file.

Because this repository is the one place both formats are live at once, the
SQLite side is *always* qualified: "SQLite database", the `.sqlite` file, or the
`sql.js` `Database` instance (aliased `SqlDatabase`). Bare "database" in prose
means the `.cdb`.

## Commands

- Install: `npm install`
- Build: `npm run build`
- Test once: `npm test`
- Test watch: `npm run test:watch`
- Coverage: `npm run coverage`
- Format: `npm run format`
- Lint: `npm run lint`

## Working Rules

- Use Node 22 or newer. The package declares `engines.node >=22.0.0`.
- Treat this repository as a published JavaScript/TypeScript library, not an app. Changes must respect common library standards: stable public API shape, typed exports, predictable module resolution, minimal side effects, and backward-compatible package metadata unless a breaking change is explicitly intended.
- The library must remain compatible with both Node.js and browser environments. Do not introduce Node-only runtime assumptions into shared code paths, public APIs, or examples unless they are clearly isolated behind environment-specific boundaries.
- `npm run lint` runs `biome lint --write .` and can modify files. Use it intentionally.
- The build emits both ESM and CommonJS outputs. Keep the tsup output extensions aligned with `package.json` exports: `.mjs` for ESM and `.cjs` for CommonJS.
- Preserve the isomorphic packaging model when editing exports, dependencies, or build config.
- Prefer small targeted changes and validate with the narrowest relevant command first.

## Collaboration And Release Conventions

- Respect standard JavaScript library conventions for commits, pull requests, tags, and releases.
- Prefer Conventional Commit style when proposing commit messages or PR titles, especially for changes that affect release notes or semantic versioning.
- Keep pull requests focused, with a clear scope, user-visible impact, and explicit note when a change is breaking.
- Treat versioning and release artifacts as semver-driven. Breaking API or packaging changes must be clearly identified so they can drive a major release.
- Prefer annotated version tags that match the package release version format, such as `v0.1.0`, unless the repository documents another convention.
- When preparing release-related changes, make sure changelog, package metadata, exports, and release notes stay coherent with the actual API and runtime compatibility.

## Conversion Invariants

- Preserve original CDB column order during `cdbToSql`. Do not sort columns unless the file format requires it.
- Keep round-trip metadata behavior intact. `cdbToSql` stores table flags on the sql.js database instance via `_tableFlagsMap` for `sqlToCdb` to reuse.
- Preserve the special `DB_STRUCTURE` table semantics used to round-trip table metadata.
- `decompressCdb` accepts both compressed and already-uncompressed input. Do not assume the zlib wrapper is always present.

## Tests

- Tests live in [test/](test/).
- Add or update Vitest coverage when changing binary parsing, metadata handling, compression, or SQL schema generation.
- For round-trip changes, prefer assertions that verify both data values and metadata preservation.

## References

- API usage and examples: [README.md](README.md)
- Build/export behavior note: [build-notes.md](memories/repo/build-notes.md)
