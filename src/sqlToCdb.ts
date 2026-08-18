/**
 * Convert SQLite database back to CDB binary format
 */

import { compressCdb } from "./compression";
import { escapeSqlIdentifier } from "./sqlUtils";
import { CDBWriter } from "./writer";
import { TABLE_FLAGS_BY_ID } from "./tableMetadata";
import { ChunkType, DataType, Magic } from "./types";
import type { ColumnMetadata, SqlDatabase } from "./types";

function toDataType(value: number): DataType {
	switch (value) {
		case DataType.INTEGER:
		case DataType.FLOAT:
		case DataType.STRING:
		case DataType.BOOLEAN:
		case DataType.INTEGER_BYTE:
		case DataType.INTEGER_SHORT:
		case DataType.FLOAT_LIST:
		case DataType.INTEGER_LIST:
			return value;
		default:
			throw new Error(`Unsupported CDB data type: ${value}`);
	}
}

function parseColumnMetadata(colName: string, colType: string): ColumnMetadata {
	const trimmedType = colType.trim();
	const match = trimmedType.match(/^(\S+)\s+(\d+)$/);
	if (!match) {
		throw new Error(
			`Invalid encoded column type for "${colName}": expected "<sqlite type> <encoded number>", got "${colType}"`,
		);
	}

	const sqliteType = match[1];
	const encodedValue = Number.parseInt(match[2], 10);
	const dataType = encodedValue & 0xf;
	const columnIndex = Math.floor(encodedValue / 16) & 0xff;

	return {
		sqliteType,
		cdbDataType: toDataType(dataType),
		cdbColumnIndex: columnIndex,
	};
}

/**
 * Convert SQLite database back to CDB binary format
 * @param db - sql.js Database instance (must have DB_STRUCTURE table)
 * @returns Compressed CDB binary data (ArrayBuffer)
 */
export function sqlToCdb(db: SqlDatabase): ArrayBuffer {
	const structureInfo = db.exec(`PRAGMA table_info("DB_STRUCTURE")`);
	const hasFlagsColumn =
		structureInfo.length > 0 &&
		structureInfo[0].values.some((row) => row[1] === "Flags");

	const tablesResult = db.exec(
		hasFlagsColumn
			? `SELECT TableName, ID, Flags FROM DB_STRUCTURE ORDER BY ID`
			: `SELECT TableName, ID FROM DB_STRUCTURE ORDER BY ID`,
	);
	if (tablesResult.length === 0) {
		throw new Error("No DB_STRUCTURE table found");
	}

	const tables = tablesResult[0].values.map((row) => ({
		name: row[0] as string,
		id: row[1] as number,
		flags: hasFlagsColumn ? (row[2] as number | null) : null,
	}));

	// DB_METADATA only exists when the .sqlite was produced with preciseTypes;
	// otherwise fall back to the highest table ID, which matches the real
	// DATABASE_FLAGS value in every known PCM save except one (off by one).
	const metadataInfo = db.exec(`PRAGMA table_info("DB_METADATA")`);
	const hasMetadataTable =
		metadataInfo.length > 0 &&
		metadataInfo[0].values.some((row) => row[1] === "DatabaseFlags");
	const storedDatabaseFlags = hasMetadataTable
		? (db.exec(`SELECT DatabaseFlags FROM DB_METADATA`)[0]?.values[0]?.[0] as
				| number
				| undefined)
		: undefined;
	const databaseFlags =
		storedDatabaseFlags ??
		(tables.length > 0 ? Math.max(...tables.map((t) => t.id)) : 274);

	const pageCountResult = db.exec(`PRAGMA page_count`);
	const pageSizeResult = db.exec(`PRAGMA page_size`);
	const pageCount = Number(pageCountResult[0]?.values[0]?.[0]);
	const pageSize = Number(pageSizeResult[0]?.values[0]?.[0]);
	const estimatedSize = pageCount * pageSize;
	const writer =
		Number.isFinite(estimatedSize) && estimatedSize > 0
			? new CDBWriter(estimatedSize)
			: new CDBWriter();

	writer.writeChunkOpen(ChunkType.WRAPPER, "cyanide database");
	writer.writeChunkOpen(ChunkType.DATABASE_FLAGS);
	writer.write32(databaseFlags);
	writer.writeChunkClose();

	writer.writeChunkOpen(ChunkType.DATABASE_TABLES);
	writer.write32(Magic.ARRAY_BEGIN);
	writer.write32(tables.length);

	tables.forEach((tableInfo) => {
		const escapedTableName = escapeSqlIdentifier(tableInfo.name);
		const schemaResult = db.exec(`PRAGMA table_info("${escapedTableName}")`);
		if (schemaResult.length === 0 || schemaResult[0].values.length === 0) {
			throw new Error(
				`No schema information available for table "${tableInfo.name}"`,
			);
		}

		const columnInfo: Record<string, ColumnMetadata> = {};

		schemaResult[0].values.forEach((row) => {
			const colName = row[1] as string;
			const colType = row[2] as string;

			columnInfo[colName] = parseColumnMetadata(colName, colType);
		});

		const dataResult = db.exec(`SELECT * FROM "${escapedTableName}"`);
		const rows = dataResult.length > 0 ? dataResult[0].values : [];

		writer.writeChunkOpen(ChunkType.TABLE, tableInfo.name);

		writer.writeChunkOpen(ChunkType.TABLE_ID);
		writer.write32(tableInfo.id);
		writer.writeChunkClose();

		writer.writeChunkOpen(ChunkType.ROW_COUNT);
		writer.write32(rows.length);
		writer.writeChunkClose();

		writer.writeChunkOpen(ChunkType.TABLE_FLAGS);
		const tableFlags = tableInfo.flags ?? TABLE_FLAGS_BY_ID[tableInfo.id] ?? 0;
		writer.write32(tableFlags);
		writer.writeChunkClose();

		writer.writeChunkOpen(ChunkType.COLUMN_DEFINITIONS);
		writer.write32(Magic.ARRAY_BEGIN);
		writer.write32(Object.keys(columnInfo).length);

		// Transpose row data to column data in single pass
		const columnNames = Object.keys(columnInfo);
		const columnData: unknown[][] = columnNames.map(() => []);
		rows.forEach((row) => {
			row.forEach((value, colIdx) => {
				columnData[colIdx].push(value);
			});
		});

		columnNames.forEach((columnName, colIdx) => {
			writer.writeChunkOpen(ChunkType.COLUMN, columnName);

			const info = columnInfo[columnName];

			writer.writeChunkOpen(ChunkType.COLUMN_INDEX);
			writer.write32(info.cdbColumnIndex);
			writer.writeChunkClose();

			writer.writeChunkOpen(ChunkType.COLUMN_DATA_TYPE, columnName);
			writer.write32(info.cdbDataType);
			writer.writeChunkClose();

			const values = columnData[colIdx];
			if (values.length !== rows.length) {
				throw new Error(
					`Missing value(s) in table "${tableInfo.name}", column "${columnName}": expected ${rows.length} rows, got ${values.length}. ` +
						"Ensure every row has a concrete value for every column (the CDB format cannot represent NULL).",
				);
			}
			for (let rowIdx = 0; rowIdx < values.length; rowIdx++) {
				const value = values[rowIdx];
				if (value === null || value === undefined) {
					throw new Error(
						`NULL or missing value in table "${tableInfo.name}", column "${columnName}", row ${rowIdx + 1}. ` +
							"The CDB format cannot represent NULL; supply a concrete value for every cell.",
					);
				}
			}
			writer.writeColumnData(info.cdbDataType, values);

			writer.writeChunkClose();
		});

		writer.write32(Magic.ARRAY_END);
		writer.writeChunkClose();

		writer.writeChunkClose();
	});

	writer.write32(Magic.ARRAY_END);
	writer.writeChunkClose();
	writer.writeChunkClose();

	return compressCdb(writer.getData());
}
