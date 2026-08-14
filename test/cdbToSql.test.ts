import type { BindParams, QueryExecResult } from "sql.js";
import { describe, expect, it, vi } from "vitest";
import { cdbToSql } from "../src/index";
import type { SqlJsStatic } from "../src/types";
import { MockSqlDatabaseBase, MockStatement } from "./mocks/mockSqlDatabase";

vi.mock("../src/compression", () => ({
	decompressCdb: vi.fn((data: ArrayBuffer | Uint8Array) => data),
}));

const mockReadChunk = vi.fn();

vi.mock("../src/reader", () => ({
	CDBReader: class MockCDBReader {
		readChunk() {
			return mockReadChunk();
		}
	},
}));

type MockSqlDatabase = MockDatabase;

function createMockSqlJs(): SqlJsStatic & {
	createdDatabases: MockSqlDatabase[];
} {
	const createdDatabases: MockSqlDatabase[] = [];

	class MockDatabaseImpl extends MockDatabase {
		constructor() {
			super();
			createdDatabases.push(this);
		}
	}

	return {
		Database: MockDatabaseImpl,
		Statement: MockStatement,
		createdDatabases,
	};
}

class MockDatabase extends MockSqlDatabaseBase {
	tables: Map<string, { rows: unknown[][] }> = new Map();
	sqlOperations: Array<{ sql: string; params?: BindParams }> = [];

	override run(sql: string, params?: BindParams): this {
		this.sqlOperations.push({ sql, params });

		if (sql.includes("CREATE TABLE")) {
			const match = sql.match(/CREATE TABLE "?(\w+)"?/);
			if (match) {
				this.tables.set(match[1], { rows: [] });
			}
		} else if (sql.includes("INSERT INTO")) {
			const match = sql.match(/INSERT INTO "?(\w+)"?/);
			if (match) {
				const table = this.tables.get(match[1]);
				if (table && Array.isArray(params)) {
					table.rows.push(params);
				}
			}
		}

		return this;
	}

	override exec(sql: string): QueryExecResult[] {
		if (sql.includes("SELECT TableName, ID FROM DB_STRUCTURE")) {
			return [
				{
					columns: ["TableName", "ID"],
					values: [
						["TestTable", 100],
						["Teams", 10],
					],
				},
			];
		}

		if (sql.includes("PRAGMA table_info")) {
			return [
				{
					columns: ["cid", "name", "type", "notnull", "dflt_value", "pk"],
					values: [
						[0, "id", "INTEGER 1600", 0, null, 0],
						[1, "name", "TEXT 1602", 0, null, 0],
					],
				},
			];
		}

		if (sql.includes("SELECT * FROM")) {
			return [
				{
					columns: ["id", "name"],
					values: [
						[1, "Test1"],
						[2, "Test2"],
					],
				},
			];
		}

		return [];
	}

	override export(): Uint8Array {
		return new Uint8Array([0, 1, 2, 3]);
	}
}

describe("cdb/sql conversion surface", () => {
	it("batches wide tables with at least one row per insert", () => {
		const sql = createMockSqlJs();
		const tableColumns = Array.from({ length: 1000 }, (_, columnIndex) => ({
			name: `col_${columnIndex}`,
			columnIndex,
			type: 0,
			data: [columnIndex],
		}));

		mockReadChunk.mockReturnValueOnce({
			children: {
				1: [
					{
						name: "WideTable",
						tableId: 1,
						tableFlags: 0,
						rowCount: 1,
						columns: tableColumns,
					},
				],
			},
		});

		cdbToSql(new Uint8Array([1, 2, 3]), sql);
		const [db] = sql.createdDatabases;

		expect(sql.createdDatabases).toHaveLength(1);
		expect(mockReadChunk).toHaveBeenCalledOnce();
		expect(db).toBeDefined();
		expect(db.sqlOperations).toContainEqual({
			sql: expect.stringContaining('INSERT INTO "WideTable" VALUES ('),
			params: expect.arrayContaining([0, 999]),
		});
		expect(
			db.sqlOperations.filter((operation) =>
				operation.sql.startsWith('INSERT INTO "WideTable" VALUES'),
			),
		).toHaveLength(1);

		mockReadChunk.mockReset();
	});

	it("collapses BOOLEAN/INTEGER_BYTE/INTEGER_SHORT to plain INTEGER by default", () => {
		const sql = createMockSqlJs();

		// DataType: INTEGER=0, FLOAT=1, BOOLEAN=3, INTEGER_BYTE=4, INTEGER_SHORT=5
		const tableColumns = [
			{ name: "id", columnIndex: 0, type: 0, data: [] },
			{ name: "flag", columnIndex: 1, type: 3, data: [] },
			{ name: "small", columnIndex: 2, type: 4, data: [] },
			{ name: "medium", columnIndex: 3, type: 5, data: [] },
			{ name: "ratio", columnIndex: 4, type: 1, data: [] },
		];

		mockReadChunk.mockReturnValueOnce({
			children: {
				1: [
					{
						name: "Narrow",
						tableId: 2,
						tableFlags: 0,
						rowCount: 0,
						columns: tableColumns,
					},
				],
			},
		});

		cdbToSql(new Uint8Array([1, 2, 3]), sql);
		const [db] = sql.createdDatabases;

		const createStatement = db.sqlOperations.find((op) =>
			op.sql.startsWith('CREATE TABLE "Narrow"'),
		);

		// tableId=2 -> base 8192 (2*4096); +columnIndex*16; nibble collapsed to 0
		// for id/flag/small/medium, kept as 1 (FLOAT) for ratio.
		expect(createStatement?.sql).toBe(
			'CREATE TABLE "Narrow" ("id" \'INTEGER 8192\', "flag" \'INTEGER 8208\', ' +
				"\"small\" 'INTEGER 8224', \"medium\" 'INTEGER 8240', \"ratio\" 'REAL 8257')",
		);

		mockReadChunk.mockReset();
	});

	it("preserves the exact CDB type with preciseTypes: true", () => {
		const sql = createMockSqlJs();

		const tableColumns = [
			{ name: "id", columnIndex: 0, type: 0, data: [] },
			{ name: "flag", columnIndex: 1, type: 3, data: [] },
			{ name: "small", columnIndex: 2, type: 4, data: [] },
			{ name: "medium", columnIndex: 3, type: 5, data: [] },
			{ name: "ratio", columnIndex: 4, type: 1, data: [] },
		];

		mockReadChunk.mockReturnValueOnce({
			children: {
				1: [
					{
						name: "Narrow",
						tableId: 2,
						tableFlags: 0,
						rowCount: 0,
						columns: tableColumns,
					},
				],
			},
		});

		cdbToSql(new Uint8Array([1, 2, 3]), sql, { preciseTypes: true });
		const [db] = sql.createdDatabases;

		const createStatement = db.sqlOperations.find((op) =>
			op.sql.startsWith('CREATE TABLE "Narrow"'),
		);

		// Same base offsets, but the true nibble (3/4/5) is kept instead of 0.
		expect(createStatement?.sql).toBe(
			'CREATE TABLE "Narrow" ("id" \'INTEGER 8192\', "flag" \'NUMERIC 8211\', ' +
				"\"small\" 'INTEGER 8228', \"medium\" 'INTEGER 8245', \"ratio\" 'REAL 8257')",
		);

		mockReadChunk.mockReset();
	});
});
