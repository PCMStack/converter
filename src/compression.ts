/**
 * CDB compression/decompression using zlib deflate
 */

import { deflate, inflate } from "pako";
import { Magic } from "./types";

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Decompress CDB data if needed (handles both compressed and uncompressed input)
 * Compressed CDB files start with magic 0xFFFFFFFF
 * @param data - Raw CDB data (may be compressed or uncompressed)
 * @returns Decompressed data as ArrayBuffer
 */
export function decompressCdb(data: ArrayBuffer | Uint8Array): ArrayBuffer {
	const bytes = toUint8Array(data);

	if (bytes.byteLength < 4) {
		return bytes.slice().buffer;
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Check if data is compressed (magic header)
	if (view.getUint32(0, true) !== Magic.COMPRESSION_MAGIC) {
		return bytes.slice().buffer;
	}

	if (bytes.byteLength < 12) {
		throw new Error("Malformed compressed CDB: incomplete compression header");
	}

	// Data is compressed
	const uncompressedSize = view.getUint32(4, true);
	const compressedSize = view.getUint32(8, true);
	const compressedEnd = 12 + compressedSize;

	if (compressedEnd > bytes.byteLength) {
		throw new Error(
			"Malformed compressed CDB: compressed payload exceeds input length",
		);
	}

	const compressedData = bytes.subarray(12, compressedEnd);

	let decompressed: Uint8Array;

	try {
		decompressed = inflate(compressedData);
	} catch {
		throw new Error("Malformed compressed CDB: invalid compressed payload");
	}

	if (decompressed.byteLength !== uncompressedSize) {
		throw new Error(
			"Malformed compressed CDB: uncompressed size does not match header",
		);
	}

	const result = new Uint8Array(decompressed.byteLength);
	result.set(decompressed);
	return result.buffer;
}

/**
 * Compress CDB data using zlib deflate
 * Output includes compression header (0xFFFFFFFF, uncompressed size, compressed size)
 * @param data - Uncompressed CDB data
 * @returns Compressed data with zlib header (ArrayBuffer)
 */
export function compressCdb(data: ArrayBuffer | Uint8Array): ArrayBuffer {
	const uncompressedData = toUint8Array(data);
	const compressed = deflate(uncompressedData);

	const result = new Uint8Array(12 + compressed.length);
	const view = new DataView(result.buffer);

	view.setUint32(0, Magic.COMPRESSION_MAGIC, true);
	view.setUint32(4, uncompressedData.length, true);
	view.setUint32(8, compressed.length, true);
	result.set(compressed, 12);

	return result.buffer.slice(
		result.byteOffset,
		result.byteOffset + result.byteLength,
	);
}
