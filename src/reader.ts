/**
 * CDB binary format reader
 * Handles parsing of chunk hierarchy, data types, and value unpacking
 */

import type { ChunkHeader, CDBChunk, ColumnData, ColumnInfo } from "./types";
import { ChunkType, DataType, Magic } from "./types";

type ColumnDefinition = Omit<ColumnInfo, "data"> & {
	data?: ColumnData;
	columnChunk?: CDBChunk;
};

export class CDBReader {
	private data: DataView;
	private pos: number;

	constructor(arrayBuffer: ArrayBuffer | Uint8Array) {
		const bytes =
			arrayBuffer instanceof Uint8Array
				? arrayBuffer
				: new Uint8Array(arrayBuffer);

		this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.pos = 0;
	}

	private getChunkChildren(chunk: CDBChunk): Record<number, unknown> {
		if (!chunk.children) {
			throw new Error(`Chunk ${chunk.type} is missing children`);
		}

		return chunk.children;
	}

	private getChunkHeader(chunk: CDBChunk): ChunkHeader {
		if (!chunk.header) {
			throw new Error(`Chunk ${chunk.type} is missing a header`);
		}

		return chunk.header;
	}

	private getRequiredDescription(chunk: CDBChunk, label: string): string {
		const description = this.getChunkHeader(chunk).description;

		if (description === null) {
			throw new Error(`Invalid ${label} chunk: missing ${label} description`);
		}

		return description;
	}

	private getRequiredChild<T>(chunk: CDBChunk, childType: number): T {
		const children = this.getChunkChildren(chunk);
		const value = children[childType];

		if (value === undefined) {
			throw new Error(`Chunk ${chunk.type} is missing child ${childType}`);
		}

		return value as T;
	}

	private read32(): number {
		if (this.pos + 4 > this.data.byteLength) {
			throw new Error(`Read past end of file at position ${this.pos}`);
		}
		const value = this.data.getUint32(this.pos, true); // little-endian
		this.pos += 4;
		return value;
	}

	private readBytes(length: number): Uint8Array {
		if (this.pos + length > this.data.byteLength) {
			throw new Error(`Read past end of file at position ${this.pos}`);
		}
		const bytes = new Uint8Array(
			this.data.buffer,
			this.data.byteOffset + this.pos,
			length,
		);
		this.pos += length;
		return bytes;
	}

	private readPadding(): void {
		const padding = (4 - (this.pos & 3)) & 3;
		this.pos += padding;
	}

	private readMagic(expected: number, label: string): void {
		const actual = this.read32();

		if (actual !== expected) {
			throw new Error(
				`Invalid ${label} magic: expected 0x${expected.toString(16)}, got 0x${actual.toString(16)}`,
			);
		}
	}

	private readChunkHeader(): ChunkHeader {
		this.readMagic(Magic.CHUNK_BEGIN, "CHUNK_BEGIN");
		const chunkSize = this.read32();
		const chunkType = this.read32();
		const flags = this.read32();
		const hasDescription = this.read32();

		let description: string | null = null;
		if (hasDescription) {
			const descLength = this.read32();
			const descBytes = this.readBytes(descLength - 1);
			description = new TextDecoder().decode(descBytes);
			this.pos++; // null terminator
		}

		this.readPadding();
		this.readMagic(Magic.CHUNK_SEPARATOR, "CHUNK_SEPARATOR");

		return { chunkSize, chunkType, flags, description };
	}

	readChunk(): CDBChunk {
		const chunkStartPos = this.pos;
		const header = this.readChunkHeader();
		const chunkEndPos = chunkStartPos + header.chunkSize;

		let result: CDBChunk;

		switch (header.chunkType) {
			case ChunkType.ROW_COUNT:
			case ChunkType.TABLE_ID:
			case ChunkType.TABLE_FLAGS:
			case ChunkType.DATABASE_FLAGS:
			case ChunkType.COLUMN_INDEX:
			case ChunkType.COLUMN_DATA_TYPE:
				result = { type: header.chunkType, value: this.read32() };
				break;

			case ChunkType.COLUMN_VALUES:
				{
					const dataBytes = chunkEndPos - this.pos - 4;
					const values: number[] = [];
					for (let i = 0; i < dataBytes / 4; i++) {
						values.push(this.read32());
					}
					result = { type: header.chunkType, value: values };
				}
				break;

			case ChunkType.COLUMN_BLOB_DATA:
				{
					const sizedDataBytes = chunkEndPos - this.pos - 4;
					result = {
						type: header.chunkType,
						value: this.readBytes(sizedDataBytes),
					};
				}
				break;

			case ChunkType.DATABASE_TABLES:
				{
					const tables = this.readArray(() => {
						const tableChunk = this.readChunk();
						const rowCount =
							this.getRequiredChild<number>(tableChunk, ChunkType.ROW_COUNT) ||
							0;
						const columnDefinitions = this.getRequiredChild<ColumnDefinition[]>(
							tableChunk,
							ChunkType.COLUMN_DEFINITIONS,
						);
						const columns: ColumnInfo[] = columnDefinitions.map((column) => ({
							name: column.name,
							type: column.type,
							columnIndex: column.columnIndex,
							data: column.columnChunk
								? this.convertColumnData(column.columnChunk, rowCount)
								: (column.data ?? []),
						}));

						const tableName = this.getRequiredDescription(tableChunk, "table");

						return {
							name: tableName,
							rowCount,
							columns,
							tableId: this.getRequiredChild<number>(
								tableChunk,
								ChunkType.TABLE_ID,
							),
							tableFlags: this.getRequiredChild<number>(
								tableChunk,
								ChunkType.TABLE_FLAGS,
							),
						};
					});
					result = { type: header.chunkType, value: tables };
				}
				break;

			case ChunkType.COLUMN_DEFINITIONS:
				{
					const columns = this.readArray(() => {
						const columnChunk = this.readChunk();
						const colName = this.getRequiredDescription(columnChunk, "column");

						return {
							name: colName,
							type: this.getRequiredChild<DataType>(
								columnChunk,
								ChunkType.COLUMN_DATA_TYPE,
							),
							columnIndex: this.getRequiredChild<number>(
								columnChunk,
								ChunkType.COLUMN_INDEX,
							),
							columnChunk: columnChunk, // Store for later conversion
						};
					});
					result = { type: header.chunkType, value: columns };
				}
				break;

			case ChunkType.WRAPPER:
			case ChunkType.TABLE:
			case ChunkType.COLUMN:
				{
					const children: Record<number, unknown> = {};
					while (this.pos < chunkEndPos) {
						if (chunkEndPos - this.pos < 20) {
							break;
						}
						const chunk = this.readChunk();
						children[chunk.type as number] = chunk.value;
					}
					result = {
						type: header.chunkType,
						header,
						children,
					};
				}
				break;

			default:
				{
					if (typeof console !== "undefined") {
						console.warn(
							`Skipping unknown chunk type: 0x${(header.chunkType as number).toString(16)} at position ${chunkStartPos}`,
						);
					}
					const skippedBytes = chunkEndPos - this.pos - 4;
					if (skippedBytes < 0) {
						throw new Error(
							`Invalid chunk size for unknown chunk type 0x${(header.chunkType as number).toString(16)} at position ${chunkStartPos}`,
						);
					}
					result = {
						type: header.chunkType,
						value: this.readBytes(skippedBytes),
					};
				}
				break;
		}

		this.readPadding();
		this.readMagic(Magic.CHUNK_END, "CHUNK_END");
		return result;
	}

	private readArray<T>(itemReader: () => T): T[] {
		this.readMagic(Magic.ARRAY_BEGIN, "ARRAY_BEGIN");
		const count = this.read32();
		const items: T[] = [];

		for (let i = 0; i < count; i++) {
			items.push(itemReader());
		}

		this.readMagic(Magic.ARRAY_END, "ARRAY_END");
		return items;
	}

	private convertColumnData(
		columnChunk: CDBChunk,
		rowCount: number,
	): ColumnData {
		const dataType = this.getRequiredChild<DataType>(
			columnChunk,
			ChunkType.COLUMN_DATA_TYPE,
		);
		const rawData =
			(this.getChunkChildren(columnChunk)[ChunkType.COLUMN_VALUES] as
				| number[]
				| undefined) ?? [];
		const sizedData =
			(this.getChunkChildren(columnChunk)[ChunkType.COLUMN_BLOB_DATA] as
				| Uint8Array
				| undefined) ?? new Uint8Array([0, 0, 0, 0]);

		// If no data, return array of zeros/empty strings based on type
		if (rawData.length === 0 && rowCount !== undefined) {
			switch (dataType) {
				case DataType.STRING:
					return Array(rowCount).fill("");
				case DataType.FLOAT:
					return Array(rowCount).fill(0.0);
				case DataType.FLOAT_LIST:
				case DataType.INTEGER_LIST:
					return Array(rowCount).fill("()");
				default:
					return Array(rowCount).fill(0);
			}
		}

		switch (dataType) {
			case DataType.INTEGER:
				return rawData.map((value) => value | 0);

			case DataType.BOOLEAN: {
				if (rowCount === undefined) {
					throw new Error("Row count required for boolean type");
				}
				const bytes = new Uint8Array(new Uint32Array(rawData).buffer);
				const boolValues: number[] = [];
				for (let i = 0; i < rowCount; i++) {
					const byteIndex = Math.floor(i / 8);
					const bitIndex = i % 8;
					boolValues.push((bytes[byteIndex] >> bitIndex) & 1);
				}
				return boolValues;
			}

			case DataType.INTEGER_BYTE: {
				const bytes = new Uint8Array(new Uint32Array(rawData).buffer).slice(
					0,
					rowCount,
				);
				return Array.from(bytes, (b) => (b > 127 ? b - 256 : b));
			}

			case DataType.INTEGER_SHORT: {
				const bytes = new Uint8Array(new Uint32Array(rawData).buffer);
				const int16Values: number[] = [];
				for (let i = 0; i < rowCount; i++) {
					const value = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
					int16Values.push(value > 32767 ? value - 65536 : value);
				}
				return int16Values;
			}

			case DataType.FLOAT: {
				const view = new DataView(new ArrayBuffer(4));
				return rawData.map((intValue) => {
					view.setUint32(0, intValue, true);
					return view.getFloat32(0, true);
				});
			}

			case DataType.STRING:
				return this.parseStrings(sizedData, rawData);

			case DataType.INTEGER_LIST:
				return this.parseNumericLists(sizedData, rawData, (view, offset) => {
					return view.getUint32(offset, true) | 0;
				});

			case DataType.FLOAT_LIST:
				return this.parseNumericLists(
					sizedData,
					rawData,
					(view, offset, count) => {
						const value = view.getFloat32(offset, true);
						let formatted = this.formatFloat32(value);
						if (
							count > 1 &&
							!formatted.includes(".") &&
							!formatted.includes("e")
						) {
							formatted += ".0";
						}
						return formatted;
					},
				);

			default:
				throw new Error(`Unknown data type: ${dataType}`);
		}
	}

	private formatFloat32(value: number): string {
		for (let precision = 1; precision <= 9; precision++) {
			const candidate = Number(value.toPrecision(precision));
			if (Math.fround(candidate) === value) {
				return candidate.toString();
			}
		}
		return value.toString();
	}

	private parseStrings(sizedData: Uint8Array, lengths: number[]): string[] {
		let currentOffset = 4;

		return lengths.map((stringLength) => {
			const stringBytes = sizedData.subarray(
				currentOffset,
				currentOffset + stringLength - 1,
			);
			currentOffset += stringLength;
			return new TextDecoder().decode(stringBytes);
		});
	}

	private parseNumericLists(
		sizedData: Uint8Array,
		counts: number[],
		readValue: (
			view: DataView,
			offset: number,
			count: number,
		) => string | number,
	): string[] {
		const view = new DataView(
			sizedData.buffer,
			sizedData.byteOffset,
			sizedData.byteLength,
		);
		let currentOffset = 4;

		return counts.map((count) => {
			const values = Array.from({ length: count }, () => {
				const value = readValue(view, currentOffset, count);
				currentOffset += 4;
				return value;
			});
			return `(${values.join(",")})`;
		});
	}
}
