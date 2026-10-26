import test from "node:test";
import assert from "node:assert/strict";
import { handleDownloadMessage, registerDownloads } from "../src/download-manager.js";

test("direct file imports reject invalid URLs, folders and missing host access without requiring a tab", async () => {
  const previous = globalThis.chrome;
  const previousLocks = navigator.locks;
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name, callback) => callback() } });
  globalThis.chrome = {
    runtime: { getURL: path => path, getContexts: async () => [] },
    storage: { local: { get: async () => ({ downloadQueue: { revision: 0, jobs: [] } }) } },
    bookmarks: { get: async id => id === "folder" ? [{ id }] : [{ id, url: "file:///bookmark", title: "Bookmark" }] },
    permissions: { contains: async () => false }
  };
  try {
    for (const resourceUrl of ["javascript:alert(1)", "file:///private", "blob:https://site.test/id", "https://user:password@site.test/file", "bad"]) {
      await assert.rejects(handleDownloadMessage("start-url", { bookmarkId: "bookmark", resourceUrl }), /HTTP или HTTPS/);
    }
    await assert.rejects(handleDownloadMessage("start-url", { resourceUrl: "https://site.test/file" }), /HTTP или HTTPS/);
    await assert.rejects(handleDownloadMessage("start-url", { bookmarkId: "folder", resourceUrl: "https://site.test/file" }), /папкой/);
    await assert.rejects(handleDownloadMessage("start-url", { bookmarkId: "bookmark", resourceUrl: "https://site.test/file" }), /доступ к сайту/);
  } finally {
    globalThis.chrome = previous;
    if (previousLocks === undefined) delete navigator.locks;
    else Object.defineProperty(navigator, "locks", { configurable: true, value: previousLocks });
  }
});

test("incognito has its own queue and never recovers or clears regular downloads", async () => {
  const previous = globalThis.chrome;
  const previousLocks = navigator.locks;
  const regular = { revision: 8, jobs: [{ id: "regular", revision: 1, status: "downloading" }] };
  const stored = { downloadQueue: structuredClone(regular), downloadJob: { id: "legacy", status: "queued" } };
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name, callback) => callback() } });
  globalThis.chrome = {
    extension: { inIncognitoContext: true },
    runtime: { getURL: path => path, getContexts: async () => [] },
    storage: { local: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, structuredClone(value)) } }
  };
  try {
    assert.deepEqual((await handleDownloadMessage("status", {})).jobs, []);
    assert.deepEqual(stored.downloadQueue, regular);
    await assert.rejects(handleDownloadMessage("prepare-previews", { resourceIds: ["../invalid"] }), /Некорректный список/);
    stored.incognitoDownloadQueue.jobs.push({ id: "private", revision: 1, status: "downloading" });
    assert.equal((await handleDownloadMessage("status", {})).jobs[0].status, "interrupted");
    await handleDownloadMessage("clear-finished", {});
    assert.deepEqual(stored.incognitoDownloadQueue.jobs, []);
    assert.deepEqual(stored.downloadQueue, regular);
  } finally {
    globalThis.chrome = previous;
    if (previousLocks === undefined) delete navigator.locks;
    else Object.defineProperty(navigator, "locks", { configurable: true, value: previousLocks });
  }
});

test("retry reuses saved tasks, appends them after waiting jobs and ignores duplicate or stale requests", async () => {
  const previous = globalThis.chrome;
  const previousLocks = navigator.locks;
  const makeJob = (id, status) => ({ id, status, revision: 3, url: "https://page.test/video", bookmarkId: "bookmark", directoryName: "Resources",
    candidate: { url: `https://cdn.test/${id}.m3u8`, transport: "hls" }, loadedBytes: 100, totalBytes: 200 });
  let queue = { revision: 10, jobs: [makeJob("active", "downloading"), makeJob("failed", "error"), makeJob("waiting", "queued"), makeJob("interrupted", "interrupted"), makeJob("done", "done")] };
  const active = structuredClone(queue.jobs[0]);
  const failed = structuredClone(queue.jobs[1]);
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name, callback) => callback() } });
  globalThis.chrome = {
    runtime: { getURL: path => path, getContexts: async () => [{}], sendMessage: async () => ({ ok: true, value: { job: active, busy: true } }) },
    storage: { local: { get: async () => ({ downloadQueue: structuredClone(queue) }), set: async value => { queue = structuredClone(value.downloadQueue); } } }
  };
  try {
    await handleDownloadMessage("retry", { id: "failed" });
    assert.deepEqual(queue.jobs.map(job => job.id), ["active", "waiting", "interrupted", "done", "failed"]);
    const retry = queue.jobs.at(-1);
    assert.equal(retry.status, "queued");
    assert.deepEqual(retry.candidate, failed.candidate);
    assert.equal(retry.bookmarkId, failed.bookmarkId);
    assert.equal(retry.directoryName, failed.directoryName);
    assert.equal(retry.revision, 4);
    assert.equal(retry.loadedBytes, 0);
    assert.equal(retry.totalBytes, 200);
    const revision = queue.revision;
    await handleDownloadMessage("retry", { id: "failed" });
    await handleDownloadMessage("retry", { id: "done" });
    await handleDownloadMessage("retry", { id: "removed" });
    await handleDownloadMessage("save", { job: failed }, true);
    assert.equal(queue.revision, revision);
    assert.equal(queue.jobs.at(-1).status, "queued");
    await handleDownloadMessage("retry", { id: "interrupted" });
    assert.equal(queue.jobs.at(-1).id, "interrupted");
    assert.equal(queue.jobs.at(-1).status, "queued");
    queue.jobs.push({ ...failed, id: "other-failed" });
    await assert.rejects(handleDownloadMessage("retry", { id: "other-failed" }), /уже добавлено/);
  } finally {
    globalThis.chrome = previous;
    if (previousLocks === undefined) delete navigator.locks;
    else Object.defineProperty(navigator, "locks", { configurable: true, value: previousLocks });
  }
});

test("clear finished persists only active and waiting jobs and ignores late updates for removed entries", async () => {
  const previous = globalThis.chrome;
  const previousLocks = navigator.locks;
  const states = ["starting", "downloading", "saving", "queued", "permissions", "done", "cancelled", "error", "interrupted"];
  let queue = { revision: 10, jobs: states.map(status => ({ id: status, status, revision: 1 })) };
  let writes = 0;
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name, callback) => callback() } });
  globalThis.chrome = { storage: { local: {
    get: async () => ({ downloadQueue: structuredClone(queue) }),
    set: async value => { queue = structuredClone(value.downloadQueue); writes++; }
  } } };
  try {
    const result = await handleDownloadMessage("clear-finished", {});
    assert.deepEqual(result.jobs.map(job => job.status), states.slice(0, 5));
    assert.deepEqual(queue, result);
    assert.equal(queue.revision, 11);
    await handleDownloadMessage("save", { job: { id: "done", status: "done", revision: 99 } }, true);
    assert.equal(queue.jobs.length, 5);
    assert.deepEqual(await handleDownloadMessage("clear-finished", {}), result);
    assert.equal(writes, 1);
    queue.jobs = [{ id: "finished-only", status: "done", revision: 1 }];
    assert.deepEqual((await handleDownloadMessage("clear-finished", {})).jobs, []);
    assert.deepEqual(queue.jobs, []);
  } finally {
    globalThis.chrome = previous;
    if (previousLocks === undefined) delete navigator.locks;
    else Object.defineProperty(navigator, "locks", { configurable: true, value: previousLocks });
  }
});

test("background jobs recover interruption, preserve newer progress and restrict internal commands", async () => {
  const previous = globalThis.chrome;
  const previousLocks = navigator.locks;
  let job = { id: "one", revision: 1, status: "downloading" };
  let queue;
  let listener;
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name, callback) => callback() } });
  globalThis.chrome = {
    runtime: { id: "extension", getURL: path => `chrome-extension://extension/${path}`, getContexts: async () => [],
      onMessage: { addListener: value => { listener = value; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { get: async () => ({ downloadJob: job, downloadQueue: queue }), set: async value => { queue = structuredClone(value.downloadQueue); job = queue.jobs[0]; } } }
  };
  try {
    assert.equal((await handleDownloadMessage("status", {})).jobs[0].status, "interrupted");
    assert.equal(job.revision, 2);
    await handleDownloadMessage("save", { job: { ...job, revision: 1, status: "downloading" } }, true);
    assert.equal(job.status, "interrupted");
    await handleDownloadMessage("save", { job: { id: "other", revision: 99 } }, true);
    assert.equal(job.id, "one");
    await assert.rejects(handleDownloadMessage("counts", {}, false), /только фоновому/);
    job.status = "permissions";
    assert.equal((await handleDownloadMessage("cancel", { id: "other" })).jobs[0].status, "permissions");
    assert.equal((await handleDownloadMessage("cancel", { id: "one" })).jobs[0].status, "cancelled");
    registerDownloads();
    const response = await new Promise(resolve => listener({ target: "download-background", type: "status" }, { id: "foreign", url: "https://site.test" }, resolve));
    assert.equal(response.ok, false);
  } finally {
    globalThis.chrome = previous;
    if (previousLocks === undefined) delete navigator.locks;
    else Object.defineProperty(navigator, "locks", { configurable: true, value: previousLocks });
  }
});

test("queue runs in order, cancels only the selected item and skips tasks waiting for permissions", async () => {
  const previous = globalThis.chrome;
  const previousLocks = navigator.locks;
  let queue = { revision: 1, jobs: [
    { id: "first", revision: 1, status: "downloading" },
    { id: "cancel-me", revision: 1, status: "queued" },
    { id: "permission", revision: 1, status: "permissions" },
    { id: "next", revision: 1, status: "queued" },
    { id: "last", revision: 1, status: "queued" }
  ] };
  let current = { ...queue.jobs[0] };
  let busy = true;
  let context = true;
  const started = [];
  const cancelled = [];
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name, callback) => callback() } });
  globalThis.chrome = {
    runtime: { getURL: path => path, getContexts: async () => context ? [{}] : [], sendMessage: async ({ type, payload }) => {
      if (type === "status") return { ok: true, value: { job: current, busy } };
      if (type === "start") { assert.equal(busy, false); started.push(payload.id); current = payload; busy = true; }
      if (type === "cancel") cancelled.push(payload.id);
      return { ok: true };
    } },
    storage: { local: { get: async () => ({ downloadQueue: structuredClone(queue) }), set: async value => { queue = structuredClone(value.downloadQueue); } } },
    offscreen: { closeDocument: async () => { context = false; } }
  };
  try {
    await handleDownloadMessage("cancel", { id: "cancel-me" });
    assert.deepEqual(queue.jobs.map(job => job.status), ["downloading", "cancelled", "permissions", "queued", "queued"]);
    assert.deepEqual(started, []);
    await handleDownloadMessage("cancel", { id: "first" });
    assert.deepEqual(cancelled, ["first"]);
    current = { ...current, status: "cancelled", revision: 2 };
    await handleDownloadMessage("save", { job: current }, true);
    busy = false;
    await handleDownloadMessage("release", { id: "first" }, true);
    assert.deepEqual(started, ["next"]);
    assert.equal(queue.jobs[2].status, "permissions");
    current = { ...current, status: "error", revision: current.revision + 1 };
    await handleDownloadMessage("save", { job: current }, true);
    busy = false;
    await handleDownloadMessage("release", { id: "next" }, true);
    assert.deepEqual(started, ["next", "last"]);
    current = { ...current, status: "done", revision: current.revision + 1 };
    await handleDownloadMessage("save", { job: current }, true);
    busy = false;
    await handleDownloadMessage("release", { id: "last" }, true);
    assert.equal(context, false);
    await handleDownloadMessage("save", { job: { id: "cancel-me", revision: 1, status: "queued" } }, true);
    assert.equal(queue.jobs[1].status, "cancelled");
    queue.jobs.push({ id: "browser-closed", revision: 1, status: "queued" });
    assert.equal((await handleDownloadMessage("status", {})).jobs.at(-1).status, "interrupted");
  } finally {
    globalThis.chrome = previous;
    if (previousLocks === undefined) delete navigator.locks;
    else Object.defineProperty(navigator, "locks", { configurable: true, value: previousLocks });
  }
});
