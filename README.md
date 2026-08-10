# cdb-converter

[![npm version](https://img.shields.io/npm/v/cdb-converter.svg)](https://www.npmjs.com/package/cdb-converter)
[![CI](https://github.com/PCMStack/converter/actions/workflows/ci.yml/badge.svg)](https://github.com/PCMStack/converter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/cdb-converter.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/cdb-converter.svg)](https://nodejs.org)

Convert **Pro Cycling Manager CDB** database files to and from SQLite, straight from the command line or your own code. Lightweight, isomorphic (Node.js **and** the browser), and zero-configuration.

The conversion is **lossless**: a full `cdb → sqlite → cdb` round-trip preserves every table, column, data type, and flag — so you can edit a database in any SQLite tool and load it back into the game. Optionally, it can reconstruct the database relationships as real `PRIMARY KEY` / `FOREIGN KEY` constraints, turning the export into a normalized database you can explore with JOINs and ER-diagram tools.

> [!NOTE]
> Based on [agfor/pcmdbedit](https://github.com/agfor/pcmdbedit/) — many thanks to agfor for the foundational work.

## Contents

- [Features](#features)
- [Getting started](#getting-started)
- [Command line](#command-line)
- [Library usage](#library-usage)
  - [CDB to SQLite](#cdb-to-sqlite)
  - [Normalized schema](#normalized-schema)
  - [SQLite to CDB](#sqlite-to-cdb)
  - [Compression](#compression)
  - [Browser](#browser)
- [API reference](#api-reference)
- [Supported data types](#supported-data-types)
- [How metadata is preserved](#how-metadata-is-preserved)
- [Compatibility](#compatibility)
- [Performance & size](#performance--size)
- [Samples](#samples)

## Features

- **CDB ↔ SQLite** — convert between the binary CDB format and standard SQLite databases.
- **CLI included** — convert files without writing any code; direction is auto-detected.
- **Lossless round-trip** — table flags, column order, and data types survive an export/reopen cycle.
- **Optional relational schema** — reconstruct `PRIMARY KEY` / `FOREIGN KEY` constraints for JOINs and ER diagrams, without breaking the round-trip.
- **Isomorphic** — runs in Node.js and in the browser via [sql.js](https://github.com/sql-js/sql.js).
- **Lightweight** — the library's own code is ~28 kB, with only `pako` and `sql.js` as dependencies.
- **TypeScript-first** — native type definitions and full IDE support.
- **Tree-shakeable** — pure functions, no side effects, ESM + CommonJS builds.

## Getting started

```bash
npm install cdb-converter
```

> [!NOTE]
> Requires **Node.js 22 or newer**. In the browser, `sql.js` loads its WebAssembly runtime on demand.

The fastest way to try it is the CLI:

```bash
npx cdb-converter database.cdb
```

## Command line

The package ships a `cdb-converter` command. The conversion direction is auto-detected from the input file extension.

```bash
# CDB → SQLite (default output: database.sqlite)
npx cdb-converter database.cdb

# SQLite → CDB (default output: database.cdb)
npx cdb-converter database.sqlite

# Provide an explicit output path (directories are created as needed)
npx cdb-converter database.cdb data/database.sqlite

# Reconstruct PRIMARY KEY / FOREIGN KEY constraints (CDB → SQLite only)
npx cdb-converter database.cdb database.sqlite --normalize

# Help / version
npx cdb-converter --help
npx cdb-converter --version
```

| Input extension   | Direction    | Default output   |
| ----------------- | ------------ | ---------------- |
| `.cdb`            | CDB → SQLite | `<input>.sqlite` |
| `.sqlite` / `.db` | SQLite → CDB | `<input>.cdb`    |

| Option              | Effect                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-n`, `--normalize` | (CDB → SQLite only) reconstruct PK/FK constraints from PCM naming conventions. See [Normalized schema](#normalized-schema). |
| `--index-fk`        | Implies `--normalize`; also indexes every FK column for faster JOINs (roughly doubles output size).                         |

## Library usage

### CDB to SQLite

```typescript
import fs from "node:fs";
import initSqlJs from "sql.js";
import { cdbToSql } from "cdb-converter";

const SQL = await initSqlJs();

// Read and convert a CDB file
const cdbBuffer = fs.readFileSync("database.cdb");
const db = cdbToSql(cdbBuffer, SQL);

// Query it like any SQLite database
const result = db.exec("SELECT * FROM Teams LIMIT 5");
console.log(result[0].values);

// Export to a .sqlite file
fs.writeFileSync("database.sqlite", db.export());
```

> [!IMPORTANT]
> You must pass the initialized `sql.js` module returned by `initSqlJs()`. This library does not initialize `sql.js` for you: that setup is asynchronous and environment-specific (the caller decides how the wasm file is loaded in Node.js or the browser).

### Normalized schema

By default the SQLite output is a flat mirror of the CDB tables, with no relational constraints. Pass `{ normalize: true }` to reconstruct `PRIMARY KEY` and `FOREIGN KEY` constraints from the PCM naming conventions (`ID{table}` identity columns and `fkID{target}` references), turning the export into a proper relational database — ready for JOINs, entity-relationship diagrams, and schema introspection tools.

```typescript
const db = cdbToSql(cdbBuffer, SQL, { normalize: true });

// Relationships are now navigable:
db.exec(`
  SELECT c.gene_sz_name, t.gene_sz_name
  FROM DYN_cyclist c
  JOIN DYN_team t ON c.fkIDteam = t.IDteam
`);
```

Notes:

- **Round-trip safe.** Constraints are declarative metadata only; `sqlToCdb` ignores them, so a normalized database still converts back to a byte-identical CDB. The flag is only meaningful in the CDB → SQLite direction.
- **Foreign keys are not enforced.** `PRAGMA foreign_keys` is left OFF so orphaned references (common in real saves) never block the conversion.
- **Best-effort.** Columns whose relationship cannot be inferred simply get no constraint. Primary keys are downgraded to a plain index when the data is not unique.
- **Foreign-key indexes are opt-in.** Pass `{ normalize: true, indexForeignKeys: true }` to also index every FK column for faster JOINs. These indexes roughly double the output size and conversion time, so `normalize` alone leaves them out — the schema is fully relational either way.

```typescript
// Lean: constraints only (~+40% size)
cdbToSql(cdbBuffer, SQL, { normalize: true });

// Heavier, faster JOINs: also index FK columns (~2x size)
cdbToSql(cdbBuffer, SQL, { normalize: true, indexForeignKeys: true });
```

### SQLite to CDB

```typescript
import fs from "node:fs";
import initSqlJs from "sql.js";
import { sqlToCdb } from "cdb-converter";

const SQL = await initSqlJs();

// Load a SQLite database and convert back to CDB
const sqliteBuffer = fs.readFileSync("database.sqlite");
const db = new SQL.Database(sqliteBuffer);

const cdbBuffer = sqlToCdb(db); // automatically compressed
fs.writeFileSync("database.cdb", Buffer.from(cdbBuffer));
```

### Compression

The library handles CDB compression (zlib deflate) transparently, but the helpers are exposed if you need them directly:

```typescript
import { compressCdb, decompressCdb } from "cdb-converter";

const compressed = compressCdb(cdbData);
const decompressed = decompressCdb(compressed); // accepts compressed or raw input
```

### Browser

```html
<script src="https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/sql-wasm.js"></script>
<script type="module">
  import { cdbToSql } from "https://cdn.jsdelivr.net/npm/cdb-converter/+esm";

  const SQL = await initSqlJs({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/${file}`,
  });

  // Read a CDB from a file input
  const file = document.getElementById("cdb-input").files[0];
  const cdbBuffer = await file.arrayBuffer();

  const db = cdbToSql(cdbBuffer, SQL);
  console.log(db.exec("SELECT * FROM sqlite_master WHERE type='table'"));
</script>
```

## API reference

### `cdbToSql(cdbBuffer, SQL, options?): Database`

Convert CDB binary data into a SQLite database instance.

- **`cdbBuffer`** — `ArrayBuffer | Uint8Array`, raw CDB data (compressed or uncompressed).
- **`SQL`** — `SqlJsStatic`, the module returned by `initSqlJs()`.
- **`options.normalize`** — `boolean` (default `false`). Reconstruct PK/FK constraints from PCM naming conventions. See [Normalized schema](#normalized-schema).
- **`options.indexForeignKeys`** — `boolean` (default `false`). When normalizing, also index every FK column for faster JOINs (roughly doubles the output size).
- **returns** — a `sql.js` `Database` with the CDB tables loaded.

### `sqlToCdb(db): ArrayBuffer`

Convert a SQLite database back to CDB binary format (automatically compressed).

- **`db`** — a `sql.js` `Database` instance.
- **returns** — compressed CDB binary data as an `ArrayBuffer`.

### `compressCdb(data): ArrayBuffer`

Compress CDB data using zlib deflate. Accepts `ArrayBuffer | Uint8Array`.

### `decompressCdb(data): ArrayBuffer`

Decompress CDB data, transparently handling both compressed and already-uncompressed input.

> Lower-level building blocks (`CDBReader`, `CDBWriter`), enums (`ChunkType`, `DataType`, `Magic`), and all TypeScript types are also exported from the package root.

## Supported data types

Every CDB data type is preserved during conversion:

| Type            | Description       | Example          |
| --------------- | ----------------- | ---------------- |
| `INTEGER`       | 32-bit signed     | `42`             |
| `FLOAT`         | IEEE 754 float32  | `3.14`           |
| `STRING`        | UTF-8 text        | `"cyclist"`      |
| `BOOLEAN`       | Bit-packed        | `true` / `false` |
| `INTEGER_BYTE`  | 8-bit signed      | `-128` to `127`  |
| `INTEGER_SHORT` | 16-bit unsigned   | `0` to `65535`   |
| `FLOAT_LIST`    | Array of floats   | `(1.5,2.3,3.7)`  |
| `INTEGER_LIST`  | Array of integers | `(10,20,30)`     |

## How metadata is preserved

The library uses a special `DB_STRUCTURE` table to round-trip CDB metadata that has no native SQLite equivalent:

```sql
CREATE TABLE DB_STRUCTURE (
  TableName TEXT '274',
  ID INTEGER,
  Flags INTEGER
)
```

Each table's flags (their exact meaning is unknown but must be preserved) are stored in the `Flags` column, so they are written into the `.sqlite` file itself and survive an `export()`/reopen cycle. Column indices and data types are encoded into each column's declared type annotation. Together this makes `cdb → sqlite → cdb` lossless even when the SQLite database is saved to disk and reopened in a separate process.

## Compatibility

The CDB parser is **format-driven, not version-specific**, so it is not tied to a single Pro Cycling Manager release. Lossless round-trip conversion (`cdb → sqlite → cdb`) is tested against the official databases of:

| Version                  | Status    |
| ------------------------ | --------- |
| Pro Cycling Manager 2014 | ✅ tested |
| Pro Cycling Manager 2018 | ✅ tested |
| Pro Cycling Manager 2019 | ✅ tested |
| Pro Cycling Manager 2021 | ✅ tested |
| Pro Cycling Manager 2025 | ✅ tested |

## Performance & size

A full `cdb → sqlite → cdb` round-trip on a real ~60k-row database stays well under half a second, and the library's own code adds only **~28 kB** — the SQLite WASM runtime is the real weight, and you would pay for it with any SQLite-in-JS approach.

Normalization is opt-in and costs only what you ask for (measured against the default conversion, ~60k rows):

| Mode                             | Conversion time | Output size |
| -------------------------------- | --------------- | ----------- |
| Default (flat)                   | baseline        | baseline    |
| `normalize`                      | +~10%           | +~40%       |
| `normalize` + `indexForeignKeys` | +~40%           | +~130%      |

See **[bench/README.md](bench/README.md)** for the full per-fixture numbers, the bundle breakdown, and how to reproduce them (`npm run bench`).

## Samples

Runnable examples live in the [samples](./samples/) folder:

- [Browser](./samples/browser/) — convert a `.cdb` file to SQLite directly in the browser.
- [Node.js — CDB to SQLite](./samples/node-cdb-to-sql/) — convert a `.cdb` file into a `.sqlite` file.
- [Node.js — SQLite to CDB](./samples/node-sql-to-cdb/) — convert a `.sqlite` or `.db` file back into a `.cdb` file.

## License

MIT — see [LICENSE](./LICENSE) for details.
