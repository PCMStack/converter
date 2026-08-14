/**
 * Round-trip conversion tests (intention: no data loss).
 *
 * Drives the REAL sql.js engine (no mocks) through the same path the CLI uses:
 *   cdb -> cdbToSql -> db.export() (SQLite bytes on disk) -> reopen -> sqlToCdb -> cdb
 * then converts back to SQL and asserts the semantic content is identical.
 *
 * Comparing the decompressed/SQL *content* (not the compressed bytes) isolates the
 * question "is any data lost?" from non-deterministic deflate output. Going through
 * export()/reopen is essential: it drops any in-memory state, so it catches metadata
 * (e.g. table flags) that would only survive within a single process.
 *
 * Running across every shipped game version doubles as a multi-version support check.
 */

import { readFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { cdbToSql, sqlToCdb } from "../src/index";
import type { SqlDatabase, SqlJsStatic } from "../src/types";
import { saveFixtures } from "./fixtures/save.fixture";

let SQL: SqlJsStatic;

beforeAll(async () => {
	SQL = await initSqlJs();
});

interface TableSnapshot {
	name: string;
	id: number;
	flags: number | null;
	/** Column definitions as "name :: type" (type carries cdb type + index + tableId). */
	columns: string[];
	rows: unknown[][];
}

/**
 * Capture the full semantic content of a converted database, ordered deterministically
 * so two conversions can be compared without false negatives from table ordering.
 */
function snapshot(db: SqlDatabase): TableSnapshot[] {
	const structureInfo = db.exec(`PRAGMA table_info("DB_STRUCTURE")`);
	const hasFlagsColumn =
		structureInfo.length > 0 &&
		structureInfo[0].values.some((row) => row[1] === "Flags");

	const structure = db.exec(
		hasFlagsColumn
			? `SELECT TableName, ID, Flags FROM DB_STRUCTURE ORDER BY ID`
			: `SELECT TableName, ID FROM DB_STRUCTURE ORDER BY ID`,
	);
	if (structure.length === 0) return [];

	return structure[0].values.map((row) => {
		const name = row[0] as string;
		const id = row[1] as number;
		const flags = (hasFlagsColumn ? (row[2] ?? null) : null) as number | null;

		const schema = db.exec(`PRAGMA table_info("${name}")`);
		const columns = schema[0].values.map(
			(col) => `${col[1] as string} :: ${col[2] as string}`,
		);

		const data = db.exec(`SELECT * FROM "${name}" ORDER BY rowid`);
		const rows = data.length > 0 ? data[0].values : [];

		return { name, id, flags, columns, rows };
	});
}

describe("cdb <-> sql round-trip (no data loss)", () => {
	it.each(saveFixtures)(
		"preserves all data and table flags for %s",
		(_label, fixturePath) => {
			const original = readFileSync(fixturePath);

			// preciseTypes: true exercises full fidelity (exact CDB type + table
			// flags stored in the .sqlite itself, not the TABLE_FLAGS_BY_ID
			// fallback). The default (compatible with the official SQLiteExporter
			// tool) is covered separately below.
			const options = { preciseTypes: true };

			// 1. cdb -> sql
			const db1 = cdbToSql(original, SQL, options);
			const before = snapshot(db1);

			// 2. Serialize to SQLite bytes and reopen — mirrors the CLI writing a .sqlite
			//    file and reading it back, dropping any in-memory-only state.
			const db2 = new SQL.Database(db1.export()) as SqlDatabase;

			// 3. sql -> cdb -> sql
			const db3 = cdbToSql(sqlToCdb(db2), SQL, options);
			const after = snapshot(db3);

			try {
				// Same tables, in the same order, with the same flags.
				expect(after.map((t) => `${t.id}:${t.name}:${t.flags}`)).toEqual(
					before.map((t) => `${t.id}:${t.name}:${t.flags}`),
				);

				// Same schema and the same row data, table by table.
				for (let i = 0; i < before.length; i++) {
					expect(after[i].columns, `columns of ${before[i].name}`).toEqual(
						before[i].columns,
					);
					expect(after[i].rows, `rows of ${before[i].name}`).toEqual(
						before[i].rows,
					);
				}
			} finally {
				db1.close();
				db2.close();
				db3.close();
			}
		},
		15000,
	);

	it.each(saveFixtures)(
		"preserves row data by default (official-compatible schema, no preciseTypes)",
		(_label, fixturePath) => {
			const original = readFileSync(fixturePath);

			// Default options: DB_STRUCTURE has no Flags column and narrow CDB
			// types (BOOLEAN/INTEGER_BYTE/INTEGER_SHORT) collapse to plain INTEGER,
			// matching the official SQLiteExporter tool. Table flags round-trip via
			// the TABLE_FLAGS_BY_ID fallback instead of the .sqlite file itself, so
			// they're intentionally not asserted here (see the preciseTypes test
			// above for exact flag fidelity).
			const db1 = cdbToSql(original, SQL);
			const before = snapshot(db1);

			const db2 = new SQL.Database(db1.export()) as SqlDatabase;
			const db3 = cdbToSql(sqlToCdb(db2), SQL);
			const after = snapshot(db3);

			try {
				expect(after.map((t) => `${t.id}:${t.name}`)).toEqual(
					before.map((t) => `${t.id}:${t.name}`),
				);

				for (let i = 0; i < before.length; i++) {
					expect(after[i].columns, `columns of ${before[i].name}`).toEqual(
						before[i].columns,
					);
					expect(after[i].rows, `rows of ${before[i].name}`).toEqual(
						before[i].rows,
					);
				}
			} finally {
				db1.close();
				db2.close();
				db3.close();
			}
		},
		15000,
	);
});
