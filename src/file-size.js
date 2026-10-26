import { t, uiLocale } from "./i18n.js";
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return t("Размер неизвестен");
  const units = [t("Б"), t("КБ"), t("МБ"), t("ГБ")];
  const index = bytes ? Math.max(0, Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))) : 0;
  const value = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: index ? 1 : 0 }).format(bytes / 1024 ** index);
  return `${value} ${units[index]}`;
}
