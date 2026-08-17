import { describe, expect, it, vi } from "vitest";
import { CDBReader } from "../src/reader";
import { ChunkType, DataType, Magic } from "../src/types";
import { CDBWriter } from "../src/writer";

function createChunkBuffer(overrides?: {
	chunkBegin?: number;
	chunkSeparator?: number;
}): Uint8Array {
	const buffer = new ArrayBuffer(28);
	const view = new DataView(buffer);

	view.setUint32(0, overrides?.chunkBegin ?? Magic.CHUNK_BEGIN, true);
	view.setUint32(4, 28, true);
	view.setUint32(8, ChunkType.WRAPPER, true);
	view.setUint32(12, 0, true);
	view.setUint32(16, 0, true);
	view.setUint32(20, overrides?.chunkSeparator ?? Magic.CHUNK_SEPARATOR, true);
	view.setUint32(24, Magic.CHUNK_END, true);

	return new Uint8Array(buffer);
}

function createWrapperWithMissingColumnDescription(): Uint8Array {
	const writer = new CDBWriter();

	writer.writeChunkOpen(ChunkType.WRAPPER);
	writer.writeChunkOpen(ChunkType.DATABASE_TABLES);
	writer.write32(Magic.ARRAY_BEGIN);
	writer.write32(1);
	writer.writeChunkOpen(ChunkType.TABLE, "TestTable");
	writer.writeChunkOpen(ChunkType.ROW_COUNT);
	writer.write32(0);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.TABLE_ID);
	writer.write32(1);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.TABLE_FLAGS);
	writer.write32(0);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.COLUMN_DEFINITIONS);
	writer.write32(Magic.ARRAY_BEGIN);
	writer.write32(1);
	writer.writeChunkOpen(ChunkType.COLUMN);
	writer.writeChunkOpen(ChunkType.COLUMN_DATA_TYPE);
	writer.write32(DataType.INTEGER);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.COLUMN_INDEX);
	writer.write32(0);
	writer.writeChunkClose();
	writer.writeChunkClose();
	writer.write32(Magic.ARRAY_END);
	writer.writeChunkClose();
	writer.writeChunkClose();
	writer.write32(Magic.ARRAY_END);
	writer.writeChunkClose();
	writer.writeChunkClose();

	return writer.getData();
}

function createUnknownChunkBuffer(payloadLength: number): Uint8Array {
	const chunkSize = 28 + payloadLength;
	const buffer = new ArrayBuffer(chunkSize);
	const view = new DataView(buffer);

	view.setUint32(0, Magic.CHUNK_BEGIN, true);
	view.setUint32(4, chunkSize, true);
	view.setUint32(8, 0x99, true); // unknown chunk type
	view.setUint32(12, 0, true);
	view.setUint32(16, 0, true);
	view.setUint32(20, Magic.CHUNK_SEPARATOR, true);
	view.setUint32(24 + payloadLength, Magic.CHUNK_END, true);

	return new Uint8Array(buffer);
}

function createFloatListTable(rows: string[]): Uint8Array {
	const writer = new CDBWriter();

	writer.writeChunkOpen(ChunkType.WRAPPER);
	writer.writeChunkOpen(ChunkType.DATABASE_TABLES);
	writer.write32(Magic.ARRAY_BEGIN);
	writer.write32(1);
	writer.writeChunkOpen(ChunkType.TABLE, "TestTable");
	writer.writeChunkOpen(ChunkType.ROW_COUNT);
	writer.write32(rows.length);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.TABLE_ID);
	writer.write32(1);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.TABLE_FLAGS);
	writer.write32(0);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.COLUMN_DEFINITIONS);
	writer.write32(Magic.ARRAY_BEGIN);
	writer.write32(1);
	writer.writeChunkOpen(ChunkType.COLUMN, "values");
	writer.writeChunkOpen(ChunkType.COLUMN_DATA_TYPE);
	writer.write32(DataType.FLOAT_LIST);
	writer.writeChunkClose();
	writer.writeChunkOpen(ChunkType.COLUMN_INDEX);
	writer.write32(0);
	writer.writeChunkClose();
	writer.writeColumnData(DataType.FLOAT_LIST, rows);
	writer.writeChunkClose();
	writer.write32(Magic.ARRAY_END);
	writer.writeChunkClose();
	writer.writeChunkClose();
	writer.write32(Magic.ARRAY_END);
	writer.writeChunkClose();
	writer.writeChunkClose();

	return writer.getData();
}

function readFloatListColumn(rows: string[]): unknown[] {
	const reader = new CDBReader(createFloatListTable(rows));
	const chunk = reader.readChunk();
	const tables = (
		chunk.children as Record<number, { columns: { data: unknown[] }[] }[]>
	)[ChunkType.DATABASE_TABLES];
	return tables[0].columns[0].data;
}

describe("CDBReader", () => {
	it("throws when CHUNK_BEGIN magic is invalid", () => {
		const reader = new CDBReader(createChunkBuffer({ chunkBegin: 0x12345678 }));

		expect(() => reader.readChunk()).toThrowError(
			"Invalid CHUNK_BEGIN magic: expected 0xaaaaaaaa, got 0x12345678",
		);
	});

	it("throws when CHUNK_SEPARATOR magic is invalid", () => {
		const reader = new CDBReader(
			createChunkBuffer({ chunkSeparator: 0x87654321 }),
		);

		expect(() => reader.readChunk()).toThrowError(
			"Invalid CHUNK_SEPARATOR magic: expected 0xbbbbbbbb, got 0x87654321",
		);
	});

	it("throws when a column chunk is missing its description", () => {
		const reader = new CDBReader(createWrapperWithMissingColumnDescription());

		expect(() => reader.readChunk()).toThrowError(
			"Invalid column chunk: missing column description",
		);
	});

	it("skips an unknown chunk type instead of throwing", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reader = new CDBReader(createUnknownChunkBuffer(8));

			const chunk = reader.readChunk();

			expect(chunk.type).toBe(0x99);
			expect(chunk.value).toBeInstanceOf(Uint8Array);
			expect((chunk.value as Uint8Array).length).toBe(8);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Skipping unknown chunk type: 0x99"),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("throws when an unknown chunk declares an impossibly small size", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const buffer = createUnknownChunkBuffer(0);
			new DataView(buffer.buffer).setUint32(4, 4, true);
			const reader = new CDBReader(buffer);

			expect(() => reader.readChunk()).toThrowError(
				"Invalid chunk size for unknown chunk type 0x99 at position 0",
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	describe("FLOAT_LIST formatting", () => {
		it("round-trips small magnitude values without losing precision", () => {
			const original = Math.fround(1e-8);
			const data = readFloatListColumn([`(${original},${original})`]);

			for (const part of (data[0] as string).slice(1, -1).split(",")) {
				expect(Math.fround(Number(part))).toBe(original);
			}
		});

		it("does not corrupt exponential notation with a trailing .0", () => {
			const original = Math.fround(1e-8);
			const data = readFloatListColumn([`(${original},${original})`]);

			for (const part of (data[0] as string).slice(1, -1).split(",")) {
				expect(part).not.toMatch(/e-?\d+\.0$/);
			}
		});

		it("still appends .0 to whole-number values in multi-element lists", () => {
			const data = readFloatListColumn(["(1,2,3)"]);

			expect(data[0]).toBe("(1.0,2.0,3.0)");
		});

		it("round-trips a mix of small and whole-number values in one list", () => {
			const original = Math.fround(1e-8);
			const data = readFloatListColumn([`(${original},2)`]);
			const parts = (data[0] as string).slice(1, -1).split(",");

			expect(Math.fround(Number(parts[0]))).toBe(original);
			expect(parts[1]).toBe("2.0");
		});
	});
});
