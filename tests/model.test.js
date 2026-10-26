import { test } from "node:test";
import assert from "node:assert/strict";
import { indexTree, pathTo, searchBookmarks, safeUrl, filterResources, resourceMediaKind } from "../src/model.js";

test("media previews allow raster images and browser videos without embedding active documents", () => {
  assert.equal(resourceMediaKind("image/png"), "img");
  assert.equal(resourceMediaKind("video/webm"), "video");
  for (const type of ["image/svg+xml", "text/html", "application/pdf", "", "image/unknown"]) assert.equal(resourceMediaKind(type), null);
});

const root = { id: "0", title: "", children: [
  { id: "1", parentId: "0", title: "Работа", children: [
    { id: "2", parentId: "1", title: "Вложенная папка", children: [
      { id: "3", parentId: "2", title: "Документы", url: "https://example.com/docs" }
    ] },
    { id: "4", parentId: "1", title: "Пустая папка", children: [] }
  ] }
] };
const nodes = indexTree(root);

test("indexes every nested folder and bookmark, preserving empty folders and order", () => {
  assert.deepEqual([...nodes.keys()], ["0", "1", "2", "3", "4"]);
  assert.deepEqual(nodes.get("4").children, []);
  assert.deepEqual(pathTo(nodes, "3").map(node => node.id), ["0", "1", "2", "3"]);
});
test("searches nested bookmarks by title and URL, ignoring case and surrounding spaces", () => {
  assert.deepEqual(searchBookmarks(nodes, "  ДОКУМЕНТЫ ").map(node => node.id), ["3"]);
  assert.equal(searchBookmarks(nodes, "EXAMPLE.COM").length, 1);
  assert.equal(searchBookmarks(nodes, "Пустая").length, 0);
  assert.equal(searchBookmarks(nodes, "nothing").length, 0);
});
test("allows ordinary bookmark URLs and blocks executable or malformed URLs", () => {
  for (const url of ["https://example.com", "http://localhost:3000", "file:///C:/notes.txt", "ftp://example.com"]) assert.ok(safeUrl(url));
  for (const url of ["javascript:alert(1)", "data:text/html,test", "not a url"]) assert.equal(safeUrl(url), null);
});

test("resource search intersects the selected tag and matches filenames, bookmarks and tags", () => {
  const resources = [
    { id: "one", name: "Фото.png", bookmarkTitle: "Документы", bookmarkUrl: "https://example.com", mediaType: "image/png", tags: ["работа", "читать"] },
    { id: "two", name: "Видео.webm", bookmarkTitle: "Личное", bookmarkUrl: "https://other.test", mediaType: "video/webm", tags: ["личное"] }
  ];
  assert.equal(filterResources(resources, "", "").length, 2);
  assert.deepEqual(filterResources(resources, "  ФОТО ", "работа").map(resource => resource.id), ["one"]);
  assert.equal(filterResources(resources, "Фото", "личное").length, 0);
  assert.equal(filterResources(resources, "ЧИТАТЬ", "").length, 1);
  assert.equal(filterResources(resources, "example.com", "").length, 1);
  assert.equal(filterResources(resources, "документы", "").length, 1);
});
