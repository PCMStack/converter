#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { cdbToSql } from "./cdbToSql";
import { sqlToCdb } from "./sqlToCdb";

declare const CDB_CONVERTER_VERSION: string | undefined;
const VERSION =
	typeof CDB_CONVERTER_VERSION === "string" ? CDB_CONVERTER_VERSION : "unknown";

export type Direction = "cdb-to-sql" | "sql-to-cdb";

export interface ParsedArgs {
	command: "convert" | "help" | "version";
	input?: string;
	output?: string;
	normalize?: boolean;
	indexForeignKeys?: boolean;
	preciseTypes?: boolean;
}

const HELP_TEXT = `cdb-converter — convert Pro Cycling Manager CDB files to/from SQLite

Usage:
  cdb-converter <input> [output]
  cdb-converter --help
  cdb-converter --version

Conversion direction is auto-detected from the input extension:
  *.cdb              ->  SQLite  (default output: <input>.sqlite)
  *.sqlite | *.db    ->  CDB     (default output: <input>.cdb)

Arguments:
  input              Path to the .cdb, .sqlite or .db file to convert
  output             Optional output path (defaults based on the input)

Options:
  -h, --help         Show this help message
  -v, --version      Show the cdb-converter version
  -n, --normalize    (cdb -> sqlite only) reconstruct PRIMARY KEY / FOREIGN KEY
                     constraints from PCM naming conventions for a normalized
                     schema. Ignored when converting sqlite -> cdb.
      --index-fk     (implies --normalize) also index every foreign-key column
                     for faster JOINs. Roughly doubles the output size.
      --precise-types
                     (cdb -> sqlite only) preserve the exact CDB type (BOOLEAN,
                     INTEGER_BYTE, INTEGER_SHORT) in the SQLite schema instead
                     of collapsing them to plain INTEGER. Off by default so the
                     output stays importable by the official PCM SQLiteExporter
                     tool, which does not recognize those types.

Examples:
  cdb-converter save.cdb
  cdb-converter save.cdb save.sqlite
  cdb-converter save.cdb save.sqlite --normalize
  cdb-converter save.cdb save.sqlite --normalize --index-fk
  cdb-converter save.cdb save.sqlite --precise-types
  cdb-converter -- --data.cdb  (use -- to treat a leading-dash path as a positional argument)
  cdb-converter save.sqlite save.cdb`;

export function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	let normalize = false;
	let indexForeignKeys = false;
	let preciseTypes = false;

	let optionsEnded = false;

	for (const arg of argv) {
		if (optionsEnded) {
			positionals.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			return { command: "help" };
		}
		if (arg === "-v" || arg === "--version") {
			return { command: "version" };
		}
		if (arg === "-n" || arg === "--normalize") {
			normalize = true;
			continue;
		}
		if (arg === "--index-fk") {
			// --index-fk implies --normalize (indexes are only meaningful there).
			normalize = true;
			indexForeignKeys = true;
			continue;
		}
		if (arg === "--precise-types") {
			preciseTypes = true;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			throw new Error(
				`Unknown option "${arg}". Run "cdb-converter --help" for usage.`,
			);
		}
		positionals.push(arg);
	}

	return {
		command: "convert",
		input: positionals[0],
		output: positionals[1],
		normalize,
		indexForeignKeys,
		preciseTypes,
	};
}

/**
 * Determine the conversion direction from the input file extension.
 * Throws when the extension is not a recognised CDB/SQLite extension.
 */
export function detectDirection(inputPath: string): Direction {
	const extension = extname(inputPath).toLowerCase();

	switch (extension) {
		case ".cdb":
			return "cdb-to-sql";
		case ".sqlite":
		case ".db":
			return "sql-to-cdb";
		default:
			throw new Error(
				`Cannot detect conversion direction from "${inputPath}". ` +
					"Expected a .cdb, .sqlite or .db file.",
			);
	}
}

/**
 * Compute the default output path for a given input and direction by swapping
 * the extension (or appending one when the input has no extension).
 */
export function getDefaultOutputPath(
	inputPath: string,
	direction: Direction,
): string {
	const extension = extname(inputPath);
	const targetExtension = direction === "cdb-to-sql" ? ".sqlite" : ".cdb";

	if (extension.length > 0) {
		return `${inputPath.slice(0, -extension.length)}${targetExtension}`;
	}

	return `${inputPath}${targetExtension}`;
}

async function convert(
	input: string,
	output: string | undefined,
	normalize: boolean,
	indexForeignKeys: boolean,
	preciseTypes: boolean,
): Promise<void> {
	const direction = detectDirection(input);
	const inputPath = resolve(process.cwd(), input);
	const outputPath = resolve(
		process.cwd(),
		output ?? getDefaultOutputPath(input, direction),
	);

	const SQL = await initSqlJs();
	const inputBytes = await readFile(inputPath);

	let outputBytes: Uint8Array;
	let summary: string[] = [];

	if (direction === "cdb-to-sql") {
		const db = cdbToSql(inputBytes, SQL, {
			normalize,
			indexForeignKeys,
			preciseTypes,
		});

		try {
			const tables = db.exec(
				"SELECT TableName, ID FROM DB_STRUCTURE ORDER BY ID",
			);
			const rows = tables[0]?.values ?? [];
			summary = [
				`Tables : ${rows.length}`,
				`Normalized : ${normalize ? "yes" : "no"}`,
			];
			if (normalize && indexForeignKeys) {
				summary.push("FK indexes : yes");
			}
			if (preciseTypes) {
				summary.push("Precise types : yes");
			}

			outputBytes = db.export();
		} finally {
			db.close();
		}
	} else {
		const db = new SQL.Database(inputBytes);

		try {
			outputBytes = new Uint8Array(sqlToCdb(db));
		} finally {
			db.close();
		}
	}

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, outputBytes);

	console.log(`Input  : ${inputPath}`);
	console.log(`Output : ${outputPath}`);
	for (const line of summary) {
		console.log(line);
	}
}

export async function run(argv: string[]): Promise<void> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
		return;
	}

	if (parsed.command === "help") {
		console.log(HELP_TEXT);
		return;
	}

	if (parsed.command === "version") {
		console.log(VERSION);
		return;
	}

	if (!parsed.input) {
		console.error("Error: missing input file.\n");
		console.error(HELP_TEXT);
		process.exitCode = 1;
		return;
	}

	try {
		await convert(
			parsed.input,
			parsed.output,
			parsed.normalize ?? false,
			parsed.indexForeignKeys ?? false,
			parsed.preciseTypes ?? false,
		);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}

/**
 * Resolve a path to its real location, tolerating paths that do not exist
 * (realpathSync throws on those) by falling back to the resolved path.
 */
function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Path comparison for the entry-point check. Windows paths are compared
 * case-insensitively: the drive letter casing of argv[1] and of the module path
 * can differ for the very same file.
 */
function samePath(a: string, b: string): boolean {
	return process.platform === "win32"
		? a.toLowerCase() === b.toLowerCase()
		: a === b;
}

/**
 * True when this module is the process entry point, false when it is merely
 * imported (by the test suite, or by anything that loads the file directly),
 * in which case importing it must not run a conversion.
 *
 * Both sides must be dereferenced: npm installs the bin as a symlink
 * (node_modules/.bin/cdb-converter -> ../cdb-converter/dist/cli.mjs), and Node
 * puts the *symlink* path in process.argv[1] while import.meta.url points at
 * the real file. Comparing them without realpath makes the check always false,
 * so the CLI silently does nothing when run via npx or the installed binary.
 */
export function isDirectRun(
	argv1: string | undefined,
	moduleUrl: string,
): boolean {
	if (typeof argv1 !== "string" || argv1.length === 0) {
		return false;
	}

	return samePath(
		safeRealpath(resolve(argv1)),
		safeRealpath(fileURLToPath(moduleUrl)),
	);
}

if (isDirectRun(process.argv[1], import.meta.url)) {
	void run(process.argv.slice(2));
}
