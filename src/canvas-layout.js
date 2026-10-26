export function createCanvasHistory(initial) {
  let current = JSON.stringify(initial);
  const past = [], future = [];
  return {
    matches: layout => JSON.stringify(layout) === current,
    record(layout) {
      const next = JSON.stringify(layout);
      if (next === current) return false;
      past.push(current);
      current = next;
      future.length = 0;
      return true;
    },
    undo() {
      if (!past.length) return undefined;
      future.push(current);
      current = past.pop();
      return JSON.parse(current);
    },
    redo() {
      if (!future.length) return undefined;
      past.push(current);
      current = future.pop();
      return JSON.parse(current);
    }
  };
}

export function canvasDropEdge(rect, clientX, clientY) {
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  if (x >= 0.4 && x <= 0.6 && y >= 0.3 && y <= 0.7) return "replace";
  if (y >= 0.25 && y <= 0.75) return x < 0.5 ? "left" : "right";
  if (x >= 0.25 && x <= 0.75) return y < 0.5 ? "top" : "bottom";
  const distances = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0];
}

export function canvasResourceIds(layout) {
  return !layout ? [] : typeof layout === "string" ? [layout] : layout.children.flatMap(canvasResourceIds);
}

export function splitSizes(node) {
  return Array.isArray(node.sizes) && node.sizes.length === node.children.length
    && node.sizes.every(size => Number.isFinite(size) && size > 0 && size <= 1e6) ? node.sizes : node.children.map(() => 1);
}

export function resizeCanvasSplit(node, index, ratio) {
  const sizes = [...splitSizes(node)];
  const total = sizes[index] + sizes[index + 1];
  const share = Math.max(0.02, Math.min(0.98, ratio));
  sizes[index] = total * share;
  sizes[index + 1] = total * (1 - share);
  return { ...node, sizes };
}

export function placeResource(layout, id, targetId, edge = "right") {
  if (!layout) return id;
  const ids = canvasResourceIds(layout);
  targetId = ids.includes(targetId) ? targetId : ids.at(-1);
  if (id === targetId) return layout;
  if (edge === "swap") {
    if (ids.includes(id)) {
      const swap = node => typeof node === "string" ? node === id ? targetId : node === targetId ? id : node : { ...node, children: node.children.map(swap) };
      return swap(layout);
    }
    edge = "replace";
  }
  if (ids.includes(id)) layout = removeResource(layout, id);
  const axis = ["left", "right"].includes(edge) ? "horizontal" : "vertical";
  const after = ["right", "bottom"].includes(edge) ? 1 : 0;
  const insert = node => {
    if (typeof node === "string") return node === targetId ? edge === "replace" ? id : { axis, children: after ? [node, id] : [id, node] } : node;
    const index = node.children.indexOf(targetId);
    const children = [...node.children];
    if (edge !== "replace" && node.axis === axis && index >= 0) {
      children.splice(index + after, 0, id);
      if (!node.sizes) return { axis, children };
      const sizes = [...splitSizes(node)];
      sizes[index] /= 2;
      sizes.splice(index + after, 0, sizes[index]);
      return { axis, children, sizes };
    }
    return { ...node, children: children.map(insert) };
  };
  return insert(layout);
}

export function removeResource(layout, id) {
  if (!layout || typeof layout === "string") return layout === id ? null : layout;
  const children = [], sizes = [], weights = splitSizes(layout);
  layout.children.forEach((child, index) => {
    const remaining = removeResource(child, id);
    if (!remaining) return;
    if (!layout.sizes && !remaining.sizes && remaining.axis === layout.axis) children.push(...remaining.children);
    else children.push(remaining);
    sizes.push(weights[index]);
  });
  return children.length > 1 ? { ...layout, children, ...(layout.sizes ? { sizes } : {}) } : children[0] || null;
}

export function restoreCanvasLayout(value, available) {
  const seen = new Set();
  function restore(node) {
    if (typeof node === "string") {
      if (!available.has(node) || seen.has(node)) return null;
      seen.add(node);
      return node;
    }
    if (!node || !["horizontal", "vertical"].includes(node.axis) || !Array.isArray(node.children)) return null;
    const children = [], sizes = [], weights = splitSizes(node);
    node.children.forEach((child, index) => {
      const restored = restore(child);
      if (restored) { children.push(restored); sizes.push(weights[index]); }
    });
    return children.length > 1 ? { axis: node.axis, children, ...(node.sizes ? { sizes } : {}) } : children[0] || null;
  }
  return restore(value);
}

export function canvasLayoutKey(libraryId, folderId, collectionId) {
  const key = `resourceCanvas/${libraryId}`;
  if (collectionId) return `${key}/collection/${encodeURIComponent(collectionId)}`;
  return folderId === undefined ? key : `${key}/folder/${encodeURIComponent(folderId)}`;
}
