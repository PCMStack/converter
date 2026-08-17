/**
 * CDB binary format writer
 * Handles writing of chunk hierarchy and data type encoding
 */

import { ChunkType, DataType, Magic } from "./types";

interface ChunkInfo {
	type: ChunkType;
	startPos: number;
	size?: number;
}

export class CDBWriter {
	private buffer: Uint8Array;
	private view: DataView;
	private chunkStack: ChunkInfo[];
	private closedChunks: ChunkInfo[];
	private pos: number;

	constructor(estimatedSize: number = 1024 * 1024) {
		this.buffer = new Uint8Array(estimatedSize);
		this.view = new DataView(this.buffer.buffer);
		this.chunkStack = [];
		this.closedChunks = [];
		this.pos = 0;
	}

	private ensureCapacity(additionalBytes: number): void {
		if (this.pos + additionalBytes > this.buffer.length) {
			const newSize = Math.max(
				Math.ceil(this.buffer.length * 1.5),
				this.pos + additionalBytes,
			);
			const newBuffer = new Uint8Array(newSize);
			newBuffer.set(this.buffer);
			this.buffer = newBuffer;
			this.view = new DataView(this.buffer.buffer);
		}
	}

	write32(value: number): void {
		this.ensureCapacity(4);
		this.view.setUint32(this.pos, value, true);
		this.pos += 4;
	}

	writeBytes(bytes: Uint8Array): void {
		this.ensureCapacity(bytes.length);
		this.buffer.set(bytes, this.pos);
		this.pos += bytes.length;
	}

	private writePadding(): void {
		const padding = (4 - (this.pos & 3)) & 3;
		if (padding > 0) {
			this.ensureCapacity(padding);
			this.pos += padding;
		}
	}

	writeChunkOpen(
		chunkType: ChunkType,
		description: string | null = null,
	): void {
		const chunkStart = this.pos;

		this.write32(Magic.CHUNK_BEGIN);
		this.write32(0); // placeholder for chunk size
		this.write32(chunkType);
		this.write32(0); // flags
		this.write32(description ? 1 : 0); // hasDescription

		if (description) {
			const descBytes = new TextEncoder().encode(description);
			this.write32(descBytes.length + 1);
			this.writeBytes(descBytes);
			this.ensureCapacity(1);
			this.buffer[this.pos] = 0; // null terminator
			this.pos += 1;
		}

		this.writePadding();
		this.write32(Magic.CHUNK_SEPARATOR);

		this.chunkStack.push({ type: chunkType, startPos: chunkStart });
	}

	writeChunkClose(): void {
		const chunk = this.chunkStack.pop();
		if (!chunk) {
			throw new Error("Chunk stack underflow");
		}

		this.writePadding();
		this.write32(Magic.CHUNK_END);

		chunk.size = this.pos - chunk.startPos;
		this.closedChunks.push(chunk);
	}

	getData(): Uint8Array {
		if (this.chunkStack.length > 0) {
			throw new Error(
				`Cannot get CDB data with ${this.chunkStack.length} open chunk${this.chunkStack.length === 1 ? "" : "s"}`,
			);
		}

		for (const chunk of this.closedChunks) {
			if (chunk.size !== undefined) {
				this.view.setUint32(chunk.startPos + 4, chunk.size, true);
			}
		}

		return this.buffer.subarray(0, this.pos);
	}

	writeColumnData(dataType: DataType, values: unknown[]): void {
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);

		this.writeChunkOpen(ChunkType.COLUMN_VALUES);

		switch (dataType) {
			case DataType.INTEGER:
				for (const value of values as number[]) {
					this.write32(value);
				}
				break;

			case DataType.BOOLEAN:
				{
					const numBytes = Math.ceil(values.length / 8);
					for (let byteIdx = 0; byteIdx < numBytes; byteIdx++) {
						let byte = 0;
						for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
							const valueIdx = byteIdx * 8 + bitIdx;
							if (valueIdx < values.length && values[valueIdx]) {
								byte |= 1 << bitIdx;
							}
						}
						this.ensureCapacity(1);
						this.buffer[this.pos++] = byte;
					}
				}
				break;

			case DataType.INTEGER_BYTE:
				{
					(values as number[]).forEach((value) => {
						this.ensureCapacity(1);
						const byte = value < 0 ? value + 256 : value;
						this.buffer[this.pos++] = byte & 0xff;
					});
				}
				break;

			case DataType.INTEGER_SHORT:
				{
					(values as number[]).forEach((value) => {
						this.ensureCapacity(2);
						this.buffer[this.pos++] = value & 0xff;
						this.buffer[this.pos++] = (value >> 8) & 0xff;
					});
				}
				break;

			case DataType.FLOAT:
				{
					(values as number[]).forEach((value) => {
						view.setFloat32(0, parseFloat(String(value)), true);
						this.write32(view.getUint32(0, true));
					});
				}
				break;

			case DataType.STRING:
				this.writeStringData(values as string[]);
				break;

			case DataType.INTEGER_LIST:
			case DataType.FLOAT_LIST:
				this.writeListData(dataType, values as string[]);
				break;
		}

		this.writeChunkClose();
	}

	private writeStringData(values: string[]): void {
		const lengths: number[] = [];
		const stringData: number[] = [];
		const encoder = new TextEncoder();

		values.forEach((value) => {
			const encoded = encoder.encode(value);
			stringData.push(...encoded, 0);
			lengths.push(encoded.length + 1);
		});

		for (const len of lengths) {
			this.write32(len);
		}

		if (stringData.length > 0) {
			this.writeChunkClose();
			this.writeChunkOpen(ChunkType.COLUMN_BLOB_DATA);
			this.write32(stringData.length);
			this.writeBytes(new Uint8Array(stringData));
		}
	}

	private writeListData(dataType: DataType, values: string[]): void {
		const counts: number[] = [];
		const listData: number[] = [];

		values.forEach((value) => {
			const parsed = value.slice(1, -1); // Remove outer parens
			if (!parsed) {
				counts.push(0);
				return;
			}

			const elements = parsed.split(",");
			counts.push(elements.length);

			elements.forEach((elem) => {
				if (dataType === DataType.INTEGER_LIST) {
					listData.push(parseInt(elem, 10));
				} else {
					// FLOAT_LIST - store as uint32 bits
					const view = new DataView(new ArrayBuffer(4));
					view.setFloat32(0, parseFloat(elem), true);
					listData.push(view.getUint32(0, true));
				}
			});
		});

		for (const count of counts) {
			this.write32(count);
		}

		if (listData.length > 0) {
			this.writeChunkClose();
			this.writeChunkOpen(ChunkType.COLUMN_BLOB_DATA);
			this.write32(listData.length * 4);
			for (const value of listData) {
				this.write32(value);
			}
		}
	}
}
