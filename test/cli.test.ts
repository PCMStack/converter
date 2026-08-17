import { describe, expect, it } from "vitest";
import { detectDirection, getDefaultOutputPath, parseArgs } from "../src/cli";

describe("parseArgs", () => {
	it("returns the help command for -h / --help", () => {
		expect(parseArgs(["-h"])).toEqual({ command: "help" });
		expect(parseArgs(["--help"])).toEqual({ command: "help" });
	});

	it("returns the version command for -v / --version", () => {
		expect(parseArgs(["-v"])).toEqual({ command: "version" });
		expect(parseArgs(["--version"])).toEqual({ command: "version" });
	});

	it("prioritises help/version even with positionals present", () => {
		expect(parseArgs(["save.cdb", "--help"])).toEqual({ command: "help" });
	});

	it("parses input and output positionals", () => {
		expect(parseArgs(["save.cdb"])).toEqual({
			command: "convert",
			input: "save.cdb",
			output: undefined,
			normalize: false,
			indexForeignKeys: false,
			preciseTypes: false,
		});
		expect(parseArgs(["save.cdb", "out.sqlite"])).toEqual({
			command: "convert",
			input: "save.cdb",
			output: "out.sqlite",
			normalize: false,
			indexForeignKeys: false,
			preciseTypes: false,
		});
	});

	it("parses the --normalize / -n flag regardless of position", () => {
		expect(parseArgs(["save.cdb", "out.sqlite", "--normalize"])).toEqual({
			command: "convert",
			input: "save.cdb",
			output: "out.sqlite",
			normalize: true,
			indexForeignKeys: false,
			preciseTypes: false,
		});
		expect(parseArgs(["-n", "save.cdb"])).toEqual({
			command: "convert",
			input: "save.cdb",
			output: undefined,
			normalize: true,
			indexForeignKeys: false,
			preciseTypes: false,
		});
	});

	it("treats --index-fk as implying --normalize", () => {
		expect(parseArgs(["save.cdb", "out.sqlite", "--index-fk"])).toEqual({
			command: "convert",
			input: "save.cdb",
			output: "out.sqlite",
			normalize: true,
			indexForeignKeys: true,
			preciseTypes: false,
		});
	});

	it("parses the --precise-types flag", () => {
		expect(parseArgs(["save.cdb", "out.sqlite", "--precise-types"])).toEqual({
			command: "convert",
			input: "save.cdb",
			output: "out.sqlite",
			normalize: false,
			indexForeignKeys: false,
			preciseTypes: true,
		});
	});

	it("treats no arguments as a convert command with no input", () => {
		expect(parseArgs([])).toEqual({
			command: "convert",
			input: undefined,
			output: undefined,
			normalize: false,
			indexForeignKeys: false,
			preciseTypes: false,
		});
	});

	it("rejects unknown options instead of treating them as positionals", () => {
		expect(() => parseArgs(["save.cdb", "--normalise"])).toThrow(
			/Unknown option "--normalise"/,
		);
		expect(() => parseArgs(["-x", "save.cdb"])).toThrow(/Unknown option "-x"/);
	});

	it("treats -- as the end-of-options marker", () => {
		expect(parseArgs(["--", "--data.cdb"])).toEqual({
			command: "convert",
			input: "--data.cdb",
			output: undefined,
			normalize: false,
			indexForeignKeys: false,
			preciseTypes: false,
		});
		expect(parseArgs(["--", "--data.cdb", "-out.sqlite"])).toEqual({
			command: "convert",
			input: "--data.cdb",
			output: "-out.sqlite",
			normalize: false,
			indexForeignKeys: false,
			preciseTypes: false,
		});
		expect(
			parseArgs(["save.cdb", "out.sqlite", "--normalize", "--", "-x"]),
		).toEqual({
			command: "convert",
			input: "save.cdb",
			output: "out.sqlite",
			normalize: true,
			indexForeignKeys: false,
			preciseTypes: false,
		});
	});
});

describe("detectDirection", () => {
	it("maps .cdb to cdb-to-sql", () => {
		expect(detectDirection("save.cdb")).toBe("cdb-to-sql");
		expect(detectDirection("SAVE.CDB")).toBe("cdb-to-sql");
	});

	it("maps .sqlite and .db to sql-to-cdb", () => {
		expect(detectDirection("save.sqlite")).toBe("sql-to-cdb");
		expect(detectDirection("save.db")).toBe("sql-to-cdb");
	});

	it("throws for unknown extensions", () => {
		expect(() => detectDirection("save.txt")).toThrowError(
			/Cannot detect conversion direction/,
		);
		expect(() => detectDirection("save")).toThrowError(
			/Cannot detect conversion direction/,
		);
	});
});

describe("getDefaultOutputPath", () => {
	it("swaps .cdb for .sqlite when converting to SQLite", () => {
		expect(getDefaultOutputPath("save.cdb", "cdb-to-sql")).toBe("save.sqlite");
		expect(getDefaultOutputPath("dir/save.cdb", "cdb-to-sql")).toBe(
			"dir/save.sqlite",
		);
	});

	it("swaps the extension for .cdb when converting to CDB", () => {
		expect(getDefaultOutputPath("save.sqlite", "sql-to-cdb")).toBe("save.cdb");
		expect(getDefaultOutputPath("save.db", "sql-to-cdb")).toBe("save.cdb");
	});
});
