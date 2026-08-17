import { describe, expect, it } from "vitest";
import { compressCdb, decompressCdb } from "../src/compression";
import { CDBReader } from "../src/reader";
import { Magic } from "../src/types";
import { CDBWriter } from "../src/writer";

// Uncompressed passthrough test data
const rawTestData = new Uint8Array([
	0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
	0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
	0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
]);

// Valid CDB-like payload for compression round-trip tests
const cdbPayload = new TextEncoder().encode("cyanide database test payload");

describe("compression", () => {
	it("works without a global Buffer", () => {
		const runtime = globalThis as typeof globalThis & {
			Buffer?: typeof Buffer;
		};
		const originalBuffer = runtime.Buffer;

		Object.defineProperty(runtime, "Buffer", {
			value: undefined,
			configurable: true,
			writable: true,
		});

		try {
			expect(() => compressCdb(cdbPayload)).not.toThrow();
			expect(() => decompressCdb(rawTestData)).not.toThrow();
			expect(() => new CDBReader(rawTestData)).not.toThrow();

			const writer = new CDBWriter();
			expect(() => writer.writeBytes(rawTestData)).not.toThrow();
		} finally {
			Object.defineProperty(runtime, "Buffer", {
				value: originalBuffer,
				configurable: true,
				writable: true,
			});
		}
	});

	it("round-trips compressed data", () => {
		const compressed = compressCdb(cdbPayload.buffer);
		const view = new DataView(compressed);

		expect(view.getUint32(0, true)).toBe(Magic.COMPRESSION_MAGIC);

		const decompressed = decompressCdb(compressed);
		const originalBytes = new Uint8Array(cdbPayload.buffer);
		const decompressedBytes = new Uint8Array(decompressed);

		expect(decompressedBytes.length).toBe(originalBytes.length);
		expect(Array.from(decompressedBytes)).toEqual(Array.from(originalBytes));
	});

	it("passes through already-uncompressed data", () => {
		const decompressed = decompressCdb(rawTestData.buffer);
		const decompressedBytes = new Uint8Array(decompressed);

		expect(decompressedBytes.length).toBe(rawTestData.length);
		expect(Array.from(decompressedBytes)).toEqual(Array.from(rawTestData));
	});

	it("writes the expected compression header", () => {
		const compressed = compressCdb(cdbPayload.buffer);
		const view = new DataView(compressed);

		expect(view.getUint32(0, true)).toBe(Magic.COMPRESSION_MAGIC);

		const uncompressedSize = view.getUint32(4, true);
		expect(uncompressedSize).toBe(cdbPayload.length);

		const compressedSize = view.getUint32(8, true);
		expect(compressedSize).toBeGreaterThan(0);
		expect(compressedSize).toBeLessThan(compressed.byteLength);
	});

	it("throws a clear error for an incomplete compression header", () => {
		const malformed = new Uint8Array(8);
		const view = new DataView(malformed.buffer);

		view.setUint32(0, Magic.COMPRESSION_MAGIC, true);

		expect(() => decompressCdb(malformed)).toThrowError(
			"Malformed compressed CDB: incomplete compression header",
		);
	});

	it("throws a clear error for a truncated compressed payload", () => {
		const malformed = new Uint8Array(15);
		const view = new DataView(malformed.buffer);

		view.setUint32(0, Magic.COMPRESSION_MAGIC, true);
		view.setUint32(4, cdbPayload.length, true);
		view.setUint32(8, 8, true);

		expect(() => decompressCdb(malformed)).toThrowError(
			"Malformed compressed CDB: compressed payload exceeds input length",
		);
	});

	it("throws a clear error for an invalid compressed payload", () => {
		const malformed = new Uint8Array(16);
		const view = new DataView(malformed.buffer);

		view.setUint32(0, Magic.COMPRESSION_MAGIC, true);
		view.setUint32(4, cdbPayload.length, true);
		view.setUint32(8, 4, true);
		malformed.set([0xde, 0xad, 0xbe, 0xef], 12);

		expect(() => decompressCdb(malformed)).toThrowError(
			"Malformed compressed CDB: invalid compressed payload",
		);
	});

	it("throws a clear error when the uncompressed size does not match", () => {
		const compressed = compressCdb(cdbPayload.buffer);
		const malformed = new Uint8Array(compressed);
		const view = new DataView(malformed.buffer);

		view.setUint32(4, cdbPayload.length + 1, true);

		expect(() => decompressCdb(malformed)).toThrowError(
			"Malformed compressed CDB: uncompressed size does not match header",
		);
	});
});
