# SQLite runtime

Bundled from the official `sql.js` npm package, version **1.15.1**:

- `dist/sql-wasm.js`
- `dist/sql-wasm.wasm`
- `LICENSE`

Source: [sql.js](https://github.com/sql-js/sql.js), [npm distribution](https://www.npmjs.com/package/sql.js/v/1.15.1).

Both runtime assets are loaded locally. No install or build step is required. `package.json` marks this vendor directory as CommonJS for the Node tests; the extension uses the standard browser script build.
