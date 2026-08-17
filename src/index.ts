/**
 * cdb-converter
 * TypeScript library for converting Pro Cycling Manager CDB files
 */

export { cdbToSql } from "./cdbToSql";
export { sqlToCdb } from "./sqlToCdb";
export { compressCdb, decompressCdb } from "./compression";
export { CDBReader } from "./reader";
export { CDBWriter } from "./writer";
export { inferKeys } from "./keyInference";

export type { ForeignKey, TableKeys } from "./keyInference";
export type {
	CdbToSqlOptions,
	ChunkHeader,
	ColumnData,
	ColumnInfo,
	ColumnMetadata,
	SqlDatabase,
	SqlJsStatic,
	TableInfo,
	CDBChunk,
} from "./types";

export { ChunkType, DataType, Magic } from "./types";
export { TABLE_FLAGS_BY_ID } from "./tableMetadata";
