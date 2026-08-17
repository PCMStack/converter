/**
 * Convert CDB binary format to SQLite database
 */

import type { SqlValue } from "sql.js";
import { decompressCdb } from "./compression";
import { inferKeys } from "./keyInference";
import type { TableKeys } from "./keyInference";
import { CDBReader } from "./reader";
import { escapeSqlIdentifier } from "./sqlUtils";
import { ChunkType, DataType } from "./types";
import type {
	CdbToSqlOptions,
	SqlDatabase,
	SqlJsStatic,
	TableInfo,
} from "./types";

/** True when every value in the column is non-null and distinct (safe as a PK). */
function isUniqueNonNull(data: unknown[]): boolean {
	const seen = new Set<unknown>();
	for (const value of data) {
		if (value === null || value === undefined) return false;
		if (seen.has(value)) return false;
		seen.add(value);
	}
	return true;
}

/**
 * Given a table's base column definitions and its inferred keys, produce the
 * final `CREATE TABLE` body — with PK/FK constraints appended after the columns
 * so the encoded type strings and column order stay intact — plus any index
 * statements to run once every table exists and its rows are inserted.
 *
 * Constraints are only appended; a table with no inferred keys is returned
 * unchanged.
 */
function buildTableConstraints(
	table: TableInfo,
	keys: TableKeys | undefined,
	columnDefs: string,
	escapedTableName: string,
	options: CdbToSqlOptions | undefined,
	keyMap: Map<string, TableKeys> | null,
	enforcedPkByTable: Map<string, boolean>,
): { tableBody: string; indexes: string[] } {
	if (!keys) return { tableBody: columnDefs, indexes: [] };

	const constraints: string[] = [];
	const indexes: string[] = [];

	if (keys.primaryKey) {
		const pkColumn = table.columns.find((col) => col.name === keys.primaryKey);
		if (pkColumn && enforcedPkByTable.get(table.name)) {
			constraints.push(
				`PRIMARY KEY ("${escapeSqlIdentifier(keys.primaryKey)}")`,
			);
		} else if (pkColumn) {
			indexes.push(
				`CREATE INDEX IF NOT EXISTS "${escapeSqlIdentifier(
					`${table.name}__${keys.primaryKey}_pk_idx`,
				)}" ON "${escapedTableName}" ("${escapeSqlIdentifier(
					keys.primaryKey,
				)}")`,
			);
		}
	}

	for (const fk of keys.foreignKeys) {
		// SQLite requires FK targets to be a PRIMARY KEY / UNIQUE column. If the
		// referenced table's identity column wasn't unique/non-null it was
		// downgraded to a plain index above, so emitting the constraint here
		// would make the schema invalid the moment a consumer turns on
		// `PRAGMA foreign_keys` or runs `PRAGMA foreign_key_check`.
		const refTablePk = keyMap?.get(fk.refTable)?.primaryKey;
		const refIsEnforcedPk =
			refTablePk === fk.refColumn &&
			(enforcedPkByTable.get(fk.refTable) ?? false);

		if (refIsEnforcedPk) {
			constraints.push(
				`FOREIGN KEY ("${escapeSqlIdentifier(fk.column)}") REFERENCES ` +
					`"${escapeSqlIdentifier(fk.refTable)}" ("${escapeSqlIdentifier(
						fk.refColumn,
					)}")`,
			);
		}
		if (options?.indexForeignKeys) {
			indexes.push(
				`CREATE INDEX IF NOT EXISTS "${escapeSqlIdentifier(
					`${table.name}__${fk.column}_fk_idx`,
				)}" ON "${escapedTableName}" ("${escapeSqlIdentifier(fk.column)}")`,
			);
		}
	}

	const tableBody =
		constraints.length > 0
			? `${columnDefs}, ${constraints.join(", ")}`
			: columnDefs;

	return { tableBody, indexes };
}

/**
 * Convert CDB binary data to SQLite database instance
 * @param cdbData - Raw CDB binary data (compressed or uncompressed)
 * @param SQL - sql.js instance from initSqlJs()
 * @returns SQLite database with CDB tables loaded
 */
export function cdbToSql(
	cdbData: ArrayBuffer | Uint8Array,
	SQL: SqlJsStatic,
	options?: CdbToSqlOptions,
): SqlDatabase {
	const decompressedData = decompressCdb(cdbData);
	const reader = new CDBReader(decompressedData);
	const db = new SQL.Database() as SqlDatabase;
	db.run("PRAGMA foreign_keys = OFF");

	const wrapperChunk = reader.readChunk();
	const wrapperChildren = wrapperChunk.children;
	if (!wrapperChildren) {
		throw new Error("Missing wrapper chunk children");
	}

	const tables =
		(wrapperChildren[ChunkType.DATABASE_TABLES] as TableInfo[] | undefined) ??
		[];

	// DB_STRUCTURE mirrors the PCM convention used by sqlToCdb: TableName keeps the
	// literal type annotation '274' so the schema matches the metadata table shape
	// expected by round-trip consumers, while only the table rows are read back.
	//
	// The official SQLiteExporter tool declares this table with no SQL type
	// keyword at all (`TableName '274',ID '0'`) and no Flags column; matching that
	// exactly by default keeps our output importable there (a mismatch here isn't
	// just cosmetic — SQLiteExporter crashes on the extra/typed columns). Flags
	// persists each table's TABLE_FLAGS so it survives an export()/reopen
	// round-trip; it's only added under preciseTypes since sqlToCdb already falls
	// back to TABLE_FLAGS_BY_ID when the column is absent.
	db.run(
		options?.preciseTypes
			? `CREATE TABLE DB_STRUCTURE (TableName TEXT '274', ID INTEGER, Flags INTEGER)`
			: `CREATE TABLE DB_STRUCTURE (TableName '274',ID '0')`,
	);

	const keyMap = options?.normalize ? inferKeys(tables) : null;
	const tablesByName = new Map(tables.map((t) => [t.name, t]));
	const deferredIndexes: string[] = [];

	const enforcedPkByTable = new Map<string, boolean>();
	if (keyMap) {
		for (const [tableName, keys] of keyMap) {
			if (!keys.primaryKey) continue;
			const pkColumn = tablesByName
				.get(tableName)
				?.columns.find((col) => col.name === keys.primaryKey);
			enforcedPkByTable.set(
				tableName,
				pkColumn !== undefined && isUniqueNonNull(pkColumn.data),
			);
		}
	}

	db.run("BEGIN TRANSACTION");

	tables.forEach((table) => {
		if (options?.preciseTypes) {
			db.run(`INSERT INTO DB_STRUCTURE VALUES (?, ?, ?)`, [
				table.name,
				table.tableId,
				table.tableFlags,
			]);
		} else {
			db.run(`INSERT INTO DB_STRUCTURE VALUES (?, ?)`, [
				table.name,
				table.tableId,
			]);
		}
		const escapedTableName = escapeSqlIdentifier(table.name);

		// Keep columns in original file order (do NOT sort)
		const columnDefs = table.columns
			.map((col) => {
				const escapedColumnName = escapeSqlIdentifier(col.name);
				let baseType: string;
				let encodedType: number;
				switch (col.type) {
					case DataType.FLOAT:
						baseType = "REAL";
						encodedType = col.type;
						break;
					case DataType.STRING:
					case DataType.INTEGER_LIST:
					case DataType.FLOAT_LIST:
						baseType = "TEXT";
						encodedType = col.type;
						break;
					case DataType.BOOLEAN:
						// `SQLiteExporter` (the official PCM tool) has no case for BOOLEAN,
						// INTEGER_BYTE or INTEGER_SHORT: they all fall into its default
						// branch and get encoded as plain INTEGER. Match that by default so
						// our output stays importable there; preciseTypes opts back into
						// preserving the exact CDB type for our own round-trip.
						baseType = options?.preciseTypes ? "NUMERIC" : "INTEGER";
						encodedType = options?.preciseTypes ? col.type : DataType.INTEGER;
						break;
					case DataType.INTEGER_BYTE:
					case DataType.INTEGER_SHORT:
						baseType = "INTEGER";
						encodedType = options?.preciseTypes ? col.type : DataType.INTEGER;
						break;
					default:
						baseType = "INTEGER";
						encodedType = DataType.INTEGER;
						break;
				}

				const encodedValue =
					(table.tableId * 256 + col.columnIndex) * 16 + (encodedType & 0xf);
				return `"${escapedColumnName}" '${baseType} ${encodedValue}'`;
			})
			.join(", ");

		const { tableBody, indexes } = buildTableConstraints(
			table,
			keyMap?.get(table.name),
			columnDefs,
			escapedTableName,
			options,
			keyMap,
			enforcedPkByTable,
		);
		deferredIndexes.push(...indexes);

		db.run(`CREATE TABLE "${escapedTableName}" (${tableBody})`);

		// Insert rows in batches. 999 is sql.js/SQLite's historical bound parameter
		// limit; kept as a conservative constant rather than queried at runtime.
		if (table.rowCount > 0) {
			const columnsPerRow = table.columns.length;
			const maxRowsPerBatch = Math.max(1, Math.floor(999 / columnsPerRow));
			const placeholders = table.columns.map(() => "?").join(", ");

			for (let i = 0; i < table.rowCount; i += maxRowsPerBatch) {
				const end = Math.min(i + maxRowsPerBatch, table.rowCount);
				const batchCount = end - i;
				const valueSets = Array(batchCount)
					.fill(`(${placeholders})`)
					.join(", ");
				const params: SqlValue[] = [];

				for (let rowIdx = i; rowIdx < end; rowIdx++) {
					for (const col of table.columns) {
						params.push(col.data[rowIdx] as SqlValue);
					}
				}

				db.run(`INSERT INTO "${escapedTableName}" VALUES ${valueSets}`, params);
			}
		}
	});

	for (const indexStatement of deferredIndexes) {
		db.run(indexStatement);
	}

	db.run("COMMIT");

	return db;
}
