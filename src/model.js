export function indexTree(root) {
  const nodes = new Map();
  function visit(node) {
    nodes.set(node.id, node);
    for (const child of node.children || []) visit(child);
  }
  visit(root);
  return nodes;
}

export function pathTo(nodes, id) {
  const path = [];
  for (let node = nodes.get(id); node; node = nodes.get(node.parentId)) path.unshift(node);
  return path;
}

export function searchBookmarks(nodes, query) {
  const term = query.trim().toLocaleLowerCase();
  return [...nodes.values()].filter(node => node.url && `${node.title} ${node.url}`.toLocaleLowerCase().includes(term));
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "ftp:", "file:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function filterResources(resources, query, tag) {
  const term = query.trim().normalize("NFC").toLowerCase();
  return resources.filter(resource => (!tag || resource.tags.includes(tag)) &&
    `${resource.name} ${resource.bookmarkTitle} ${resource.bookmarkUrl} ${resource.mediaType} ${resource.tags.join(" ")}`.normalize("NFC").toLowerCase().includes(term));
}

export function resourceMediaKind(type) {
  if (["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"].includes(type)) return "img";
  if (["video/mp4", "video/webm", "video/ogg"].includes(type)) return "video";
  return null;
}
