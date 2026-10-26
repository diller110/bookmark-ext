export function messageId(source) {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return `m_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function t(source, substitutions = []) {
  const values = substitutions.map(String);
  const translated = globalThis.chrome?.i18n?.getMessage(messageId(source), values);
  return translated || source.replace(/\$([1-9])/g, (match, index) => values[Number(index) - 1] ?? match);
}

export function uiLocale() {
  return (globalThis.chrome?.i18n?.getUILanguage() || "ru").replaceAll("_", "-");
}

const localized = new WeakSet();

// Translate only the initial packaged DOM, before application code inserts user content.
export function localizeDocument(document) {
  if (localized.has(document)) return;
  localized.add(document);
  document.documentElement.lang = uiLocale();
  document.documentElement.dir = /^(ar|fa|he|ur)(-|$)/i.test(uiLocale()) ? "rtl" : "ltr";
  const walker = document.createTreeWalker(document.documentElement, 4);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest("script,style,code")) continue;
    const source = node.nodeValue.trim();
    if (/[А-Яа-яЁё]/.test(source)) node.nodeValue = node.nodeValue.replace(source, () => t(source));
  }
  for (const node of document.querySelectorAll("[title],[aria-label],[placeholder],[alt]")) {
    for (const attribute of ["title", "aria-label", "placeholder", "alt"]) {
      const source = node.getAttribute(attribute);
      if (source && /[А-Яа-яЁё]/.test(source)) node.setAttribute(attribute, t(source));
    }
  }
}

if (globalThis.document?.createTreeWalker) localizeDocument(document);
