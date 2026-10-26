import { test } from "node:test";
import assert from "node:assert/strict";
import { getResourceDirectory, setResourceDirectory } from "../src/resource-directory.js";

test("resource folder survives reopening the database; failed writes retain the previous choice", async () => {
  const previous = globalThis.indexedDB;
  const previousChrome = globalThis.chrome;
  const counters = [];
  globalThis.chrome = { storage: { local: { set: async value => counters.push(value) } } };
  const stored = new Map();
  let failWrite = false;
  let connections = 0;
  let closed = 0;
  globalThis.indexedDB = {
    open() {
      const request = {};
      connections++;
      request.result = {
        close() { closed++; },
        transaction() {
          const transaction = {
            objectStore() {
              return {
                get(key) {
                  const read = {};
                  queueMicrotask(() => { read.result = stored.get(key); read.onsuccess(); });
                  return read;
                },
                put(directory, key) {
                  queueMicrotask(() => {
                    if (failWrite) {
                      transaction.error = new Error("Disk full");
                      transaction.onabort();
                    } else {
                      stored.set(key, directory);
                      transaction.oncomplete();
                    }
                  });
                }
              };
            }
          };
          return transaction;
        }
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };
  try {
    assert.equal(await getResourceDirectory(), undefined);
    const original = { kind: "directory", name: "Resources" };
    await setResourceDirectory(original);
    assert.deepEqual(counters, [{ resourceCounts: {} }]);
    assert.equal(await getResourceDirectory(), original);
    assert.equal(counters.length, 1);
    failWrite = true;
    await assert.rejects(setResourceDirectory({ kind: "directory", name: "Other" }), /Disk full/);
    assert.equal(await getResourceDirectory(), original);
    assert.equal(closed, connections);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome;
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  }
});
