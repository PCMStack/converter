# Browser sample

This sample shows how to use `cdbToSql` in the browser with `sql.js`. It is also
the public demo, deployed to GitHub Pages at <https://pcmstack.github.io/converter/>
by [`.github/workflows/static.yml`](../../.github/workflows/static.yml), which
copies this folder verbatim.

## What it does

- Load a `.cdb` database from an `<input type="file">` or by drag and drop
- Convert it to a SQLite database, entirely in the browser
- Display the detected tables from `DB_STRUCTURE` and preview their first rows
- Download the generated `.sqlite` file

Nothing is ever uploaded: the conversion runs client-side, in WebAssembly.

## Run the sample

Serve this folder with any static HTTP server, then open `/samples/browser/` in your browser.

Example with VS Code Live Server or any equivalent local server:

1. Start a local server from the repository root
2. Open `http://127.0.0.1:4173/samples/browser/`
3. Select a `.cdb` database and click **Convert**

Opening `index.html` straight from the filesystem does not work: `app.js` is an
ES module and `sql-wasm.wasm` is fetched over HTTP, both of which browsers block
on `file://`.

## Files

- `index.html` defines the UI
- `app.js` initializes `sql.js`, runs `cdbToSql`, and prepares the SQLite download
- `style.css` maps the PCMStack design tokens onto Pico's CSS variables
- `assets/` holds the PCMStack favicon, logo mark and Open Graph card
- `vendor/` holds the third-party runtime dependencies, served from this origin

## Vendored dependencies

`vendor/` is checked in on purpose. This page hands the user's own database to
the code it loads, so it must not depend on a third-party CDN staying up or
serving what it served yesterday.

| File           | Source                                    |
| -------------- | ----------------------------------------- |
| `pico.min.css` | `@picocss/pico` v2.1.1                    |
| `sql-wasm.js`  | `sql.js` v1.14.1, from `node_modules`     |
| `sql-wasm.wasm`| `sql.js` v1.14.1, from `node_modules`     |

To refresh the `sql.js` pair after a dependency bump:

```bash
cp node_modules/sql.js/dist/sql-wasm.{js,wasm} samples/browser/vendor/
```

`app.js` points `initSqlJs`'s `locateFile` at `./vendor/`, so the `.wasm` is
resolved next to the page rather than next to the script that loaded it.

The folder is excluded from Biome in [`biome.json`](../../biome.json): these are
minified upstream artifacts and must not be reformatted.
