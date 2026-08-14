import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end guard for the CLI entry-point check.
 *
 * These tests must spawn the built CLI *through a symlink*, because that is how
 * npm/npx invoke it (node_modules/.bin/cdb-converter -> dist/cli.mjs). Calling
 * run() in-process cannot observe the bug: Node reports the symlink path in
 * process.argv[1] but the real path in import.meta.url, and a comparison that
 * does not dereference both makes the CLI exit 0 without doing anything.
 *
 * The symlink suite is skipped on Windows: fs.symlink() there needs admin
 * rights or developer mode, and npm does not symlink "bin" entries anyway (it
 * generates .cmd/.ps1 shims), so the scenario under test does not exist.
 */

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const cliPath = join(repoRoot, "dist", "cli.mjs");
const fixture = join(repoRoot, "test", "fixtures", "OfficialRelease-2014.cdb");

let workDir: string;
let linkPath: string;

function runCli(args: string[]): { status: number; stdout: string } {
	let stdout = "";
	let status = 0;

	try {
		stdout = execFileSync(process.execPath, [linkPath, ...args], {
			cwd: workDir,
			encoding: "utf8",
		});
	} catch (error) {
		const failure = error as { status?: number; stdout?: string };
		status = failure.status ?? 1;
		stdout = failure.stdout ?? "";
	}

	return { status, stdout };
}

beforeAll(async () => {
	execFileSync(npmCommand, ["run", "build"], {
		cwd: repoRoot,
		stdio: "ignore",
	});

	workDir = await mkdtemp(join(tmpdir(), "cdb-converter-cli-"));
	await copyFile(fixture, join(workDir, "input.cdb"));
}, 120_000);

afterAll(async () => {
	if (workDir) {
		await rm(workDir, { recursive: true, force: true });
	}
});

describe.skipIf(isWindows)("CLI invoked through a symlink", () => {
	beforeAll(async () => {
		await mkdir(join(workDir, "bin"));

		// Mirrors what `npm install` creates for the "bin" entry.
		linkPath = join(workDir, "bin", "cdb-converter");
		await symlink(cliPath, linkPath);
	});

	it("converts a real .cdb and writes the output file", () => {
		const { status, stdout } = runCli(["input.cdb", "output.sqlite"]);

		expect(status).toBe(0);
		expect(existsSync(join(workDir, "output.sqlite"))).toBe(true);
		expect(stdout).toContain("Output :");
		expect(stdout).toMatch(/Tables : \d+/);
	}, 120_000);

	it("converts back from .sqlite to .cdb", () => {
		expect(runCli(["input.cdb", "roundtrip.sqlite"]).status).toBe(0);

		const { status } = runCli(["roundtrip.sqlite", "roundtrip.cdb"]);

		expect(status).toBe(0);
		expect(existsSync(join(workDir, "roundtrip.cdb"))).toBe(true);
	}, 120_000);

	it("prints help and version", () => {
		const help = runCli(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage:");

		const version = runCli(["--version"]);
		expect(version.status).toBe(0);
		expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	}, 60_000);

	it("exits non-zero on a missing input file", () => {
		expect(runCli([]).status).toBe(1);
	}, 60_000);
});

describe("CLI imported as a library", () => {
	it("does not run the converter on import", async () => {
		const importer = join(workDir, "importer.mjs");
		await writeFile(
			importer,
			`import { run } from ${JSON.stringify(cliPath)};\n` +
				`console.log(typeof run);\n`,
		);

		const stdout = execFileSync(
			process.execPath,
			[importer, "input.cdb", "should-not-exist.sqlite"],
			{ cwd: workDir, encoding: "utf8" },
		);

		expect(stdout.trim()).toBe("function");
		expect(existsSync(join(workDir, "should-not-exist.sqlite"))).toBe(false);
	}, 60_000);
});
