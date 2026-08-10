import { cdbToSql } from "https://cdn.jsdelivr.net/npm/cdb-converter/+esm";

const fileInput = document.querySelector("#cdb-file");
const dropzoneCopy = document.querySelector("#dropzone-copy");
const fileName = document.querySelector("#file-name");
const fileSize = document.querySelector("#file-size");
const fileRow = document.querySelector("#file-row");
const dropzone = document.querySelector("#dropzone");
const progress = document.querySelector("#progress");
const convertButton = document.querySelector("#convert");
const copyInstallButton = document.querySelector("#copy-install");
const downloadLink = document.querySelector("#download");
const resultCard = document.querySelector("#result-card");
const status = document.querySelector("#status");
const tablesList = document.querySelector("#tables");
const previewMeta = document.querySelector("#preview-meta");
const previewHead = document.querySelector("#preview-head");
const previewBody = document.querySelector("#preview-body");
const tableCount = document.querySelector("#tcount");
const rowCount = document.querySelector("#rcount");
const sqliteSize = document.querySelector("#ssize");

let currentDb;
let selectedFile;

let downloadUrl;
let downloadFilename;

async function convertFile() {
	const file = selectedFile ?? fileInput.files?.[0];
	if (!file) {
		setStatus("Select a .cdb file");
		return;
	}

	setBusy(true);
	closeCurrentDb();
	clearDownload();
	resultCard.style.display = "none";
	setStatus(`Converting ${file.name}...`);

	const startedAt = performance.now();
	try {
		// sql.js resolves its .wasm relative to this callback, not to the script
		// URL, so it has to be pointed at the vendored copy explicitly.
		const SQL = await initSqlJs({
			locateFile: (filename) =>
				new URL(`./vendor/${filename}`, import.meta.url).href,
		});
		const cdbBuffer = await file.arrayBuffer();
		const db = cdbToSql(new Uint8Array(cdbBuffer), SQL);
		const sqliteBytes = db.export();
		const tables = db.exec(
			"SELECT TableName, ID FROM DB_STRUCTURE ORDER BY ID",
		);
		const rows = tables[0]?.values || [];
		let totalRows = 0;
		for (const [tableName] of rows) {
			const escapedName = quoteIdentifier(String(tableName));
			const count =
				db.exec(`SELECT COUNT(*) FROM ${escapedName}`)[0]?.values?.[0]?.[0] ??
				0;
			totalRows += Number(count);
		}

		currentDb = db;
		renderTables(rows);
		rowCount.textContent = totalRows.toLocaleString("en-US");
		sqliteSize.textContent = formatBytes(sqliteBytes.length);
		resultCard.style.display = "block";
		if (rows.length > 0) {
			selectTable(String(rows[0][0]));
		} else {
			clearPreview();
		}

		downloadUrl = URL.createObjectURL(
			new Blob([sqliteBytes], { type: "application/vnd.sqlite3" }),
		);
		downloadFilename = `${file.name.replace(/\.cdb$/i, "") || "converted"}.sqlite`;
		downloadLink.disabled = false;

		setStatus(
			[
				`File: ${file.name}`,
				`SQLite size: ${formatBytes(sqliteBytes.length)}`,
				`Tables: ${rows.length}`,
				`Rows: ${totalRows}`,
				`Duration: ${formatDuration(performance.now() - startedAt)}`,
			].join("\n"),
		);
	} catch (error) {
		closeCurrentDb();
		renderTables([]);
		resetStats();
		resultCard.style.display = "none";
		setStatus(error instanceof Error ? error.message : String(error));
	} finally {
		setBusy(false);
	}
}

function setStatus(message) {
	status.textContent = message;
}

function formatDuration(durationMs) {
	return durationMs >= 1000
		? `${(durationMs / 1000).toFixed(2)} s`
		: `${durationMs.toFixed(0)} ms`;
}

function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}

	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	const decimals = value >= 10 || unitIndex === 0 ? 0 : 1;
	return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function setFileLabel(file) {
	fileRow.style.display = file ? "flex" : "none";
	fileName.textContent = file ? file.name : "-";
	fileSize.textContent = file ? formatBytes(file.size) : "-";

	if (file) {
		const fileNameStrong = document.createElement("strong");
		fileNameStrong.textContent = file.name;
		dropzoneCopy.replaceChildren("Ready to convert ", fileNameStrong);
	} else {
		const extensionStrong = document.createElement("strong");
		extensionStrong.textContent = ".cdb";
		dropzoneCopy.replaceChildren("Drop a ", extensionStrong, " file here");
	}

	dropzone.dataset.hasFile = file ? "true" : "false";
}

function clearPreview() {
	previewMeta.textContent =
		"Convert a file, then pick a table to inspect its first rows.";
	previewHead.replaceChildren();
	previewBody.replaceChildren();
}

function resetStats() {
	tableCount.textContent = "0";
	rowCount.textContent = "0";
	sqliteSize.textContent = "0 B";
}

function setBusy(isBusy) {
	convertButton.disabled = isBusy;
	convertButton.setAttribute("aria-busy", isBusy ? "true" : "false");
	convertButton.textContent = isBusy ? "Converting..." : "Convert to SQLite";
	progress.style.display = isBusy ? "block" : "none";
	progress.removeAttribute("value");
}

function quoteIdentifier(identifier) {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function renderPreviewTable(result) {
	previewHead.replaceChildren();
	previewBody.replaceChildren();

	if (!result || result.columns.length === 0) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.colSpan = 1;
		cell.textContent = "No rows to preview";
		row.append(cell);
		previewBody.append(row);
		return;
	}

	const headerRow = document.createElement("tr");
	for (const column of result.columns) {
		const cell = document.createElement("th");
		cell.scope = "col";
		cell.className = "table-wrap__th";
		cell.textContent = column;
		headerRow.append(cell);
	}
	previewHead.append(headerRow);

	if (result.values.length === 0) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.colSpan = result.columns.length;
		cell.textContent = "No rows to preview";
		row.append(cell);
		previewBody.append(row);
		return;
	}

	for (const values of result.values) {
		const row = document.createElement("tr");
		for (const value of values) {
			const cell = document.createElement("td");
			cell.className = "table-wrap__td";
			if (value == null) {
				const span = document.createElement("span");
				span.className = "null-value";
				span.textContent = "null";
				cell.append(span);
			} else {
				cell.textContent = String(value);
			}
			row.append(cell);
		}
		previewBody.append(row);
	}
}

function selectTable(tableName) {
	if (!currentDb) {
		clearPreview();
		return;
	}

	for (const button of tablesList.querySelectorAll("button")) {
		button.classList.toggle(
			"tabs__item--active",
			button.dataset.tableName === tableName,
		);
	}

	const escapedName = quoteIdentifier(tableName);
	const countResult = currentDb.exec(
		`SELECT COUNT(*) AS rowCount FROM ${escapedName}`,
	);
	const rowCount = countResult[0]?.values?.[0]?.[0] ?? 0;
	const previewResult = currentDb.exec(
		`SELECT * FROM ${escapedName} LIMIT 8`,
	)[0];

	previewMeta.textContent = `${tableName} · ${rowCount} row${rowCount === 1 ? "" : "s"} · first 8 rows`;
	renderPreviewTable(previewResult);
}

function clearDownload() {
	if (downloadUrl) {
		URL.revokeObjectURL(downloadUrl);
		downloadUrl = undefined;
	}

	downloadFilename = undefined;
	downloadLink.disabled = true;
}

function renderTables(rows) {
	tablesList.replaceChildren();
	tablesList.dataset.state = rows.length === 0 ? "empty" : "ready";
	tablesList.classList.toggle("tabs--empty", rows.length === 0);
	tableCount.textContent = String(rows.length);

	for (const [tableName, tableId] of rows) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "tabs__item";
		button.dataset.tableName = String(tableName);
		button.textContent = `${tableName} (#${tableId})`;
		button.addEventListener("click", () => {
			selectTable(String(tableName));
		});
		tablesList.append(button);
	}

	if (rows.length === 0) {
		tablesList.textContent = "No tables detected";
		clearPreview();
	}
}

function handlePickedFile(file) {
	selectedFile = file;
	closeCurrentDb();
	clearDownload();
	renderTables([]);
	clearPreview();
	resetStats();
	resultCard.style.display = "none";
	setFileLabel(file);
	convertButton.style.display = file ? "block" : "none";
	setStatus(file ? "File ready. Click Convert." : "Waiting for a .cdb file");
}

function copyInstallCommand() {
	const command = "npm install cdb-converter";
	void navigator.clipboard?.writeText(command);
	copyInstallButton.innerHTML =
		'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#1D9E75" stroke-width="2" aria-hidden="true"><path d="M3 8l4 4 6-6"/></svg>';
	window.setTimeout(() => {
		copyInstallButton.innerHTML =
			'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M3 11V3a2 2 0 0 1 2-2h8"/></svg>';
	}, 1500);
}

function closeCurrentDb() {
	if (currentDb) {
		currentDb.close();
		currentDb = undefined;
	}
}

downloadLink.addEventListener("click", () => {
	if (!downloadUrl || !downloadFilename) return;
	const a = document.createElement("a");
	a.href = downloadUrl;
	a.download = downloadFilename;
	a.click();
});

convertButton.addEventListener("click", () => {
	void convertFile();
});

copyInstallButton.addEventListener("click", () => {
	copyInstallCommand();
});

fileInput.addEventListener("change", () => {
	handlePickedFile(fileInput.files?.[0]);
});

dropzone.addEventListener("dragover", (event) => {
	event.preventDefault();
	dropzone.classList.add("dropzone--over");
});

dropzone.addEventListener("dragleave", () => {
	dropzone.classList.remove("dropzone--over");
});

dropzone.addEventListener("drop", (event) => {
	event.preventDefault();
	dropzone.classList.remove("dropzone--over");
	const file = event.dataTransfer?.files?.[0];
	if (!file) {
		return;
	}

	handlePickedFile(file);
});

dropzone.addEventListener("keydown", (event) => {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		fileInput.click();
	}
});

renderTables([]);
clearPreview();
resetStats();
setFileLabel();
