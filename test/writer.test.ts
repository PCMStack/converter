import { describe, expect, it } from "vitest";
import { ChunkType } from "../src/types";
import { CDBWriter } from "../src/writer";

describe("CDBWriter", () => {
	it("throws when getData is called with open chunks", () => {
		const writer = new CDBWriter();

		writer.writeChunkOpen(ChunkType.WRAPPER);

		expect(() => writer.getData()).toThrowError(
			"Cannot get CDB data with 1 open chunk",
		);
	});
});
