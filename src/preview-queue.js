import { t } from "./i18n.js";
import { getDownloadDirectory } from "./resource-directory.js";
import { openResourceLibrary } from "./resource-library.js";
import { downloadCall } from "./extension-bridge.js";

const thumbnails = { queue: [], running: 0, limit: 3, method: "getThumbnail" };
const timelapses = { queue: [], running: 0, limit: 1, method: "getTimelapse" };
export const previewsPending = () => [thumbnails, timelapses].some(pool => pool.running || pool.queue.length);

export function enqueuePreviews(task) {
  const library = (async () => {
    const selected = await getDownloadDirectory(task.id);
    if (selected?.id !== task.id) throw new Error(t("Папка подготовки превью недоступна"));
    return openResourceLibrary(selected.directory);
  })();
  library.catch(() => {});
  for (const id of task.resourceIds) thumbnails.queue.push({ library, id });
  pump(thumbnails);
}

function pump(pool) {
  while (pool.running < pool.limit && pool.queue.length) {
    const job = pool.queue.shift();
    pool.running++;
    void (async () => {
      try { await (await job.library)[pool.method](job.id); }
      catch (error) { console.warn(t("Не удалось подготовить превью видео"), error); }
      finally {
        if (pool === thumbnails) { timelapses.queue.push(job); pump(timelapses); }
        pool.running--;
        pump(pool);
        if (!previewsPending()) await downloadCall("release").catch(console.warn);
      }
    })();
  }
}
