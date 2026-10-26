import { t } from "./i18n.js";
import "../vendor/streaming/m3u8-parser.js";
import "../vendor/streaming/mpd-parser.js";
import { mediaUrl } from "./page-media.js";
import { hostPattern } from "./media-scan.js";
import { allowedMediaOrigins } from "./extension-bridge.js";
import { fetchMedia } from "./media-fetch.js";

// shortcut: MEMFS holds the complete input; use a native/streaming backend for videos above 512 MiB.
const maxBytes = 512 * 1024 * 1024;

export class MediaPermissionsRequired extends Error {
  constructor(origins) {
    super(t("Разрешите доступ к доменам сегментов и повторите загрузку"));
    this.origins = origins;
  }
}

async function checkPermissions(urls) {
  const origins = [...new Set(urls.map(hostPattern))];
  const allowed = await allowedMediaOrigins(origins);
  const missing = origins.filter((_origin, index) => !allowed[index]);
  if (missing.length) throw new MediaPermissionsRequired(missing);
}

function remote(url, base) {
  const resolved = mediaUrl(new URL(url, base).href);
  if (!resolved) throw new Error(t("Поток содержит недопустимый адрес сегмента"));
  return resolved;
}

async function request(url, signal, range) {
  await checkPermissions([url]);
  const headers = {};
  if (range) {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length <= 0) throw new Error(t("Некорректный byte range потока"));
    headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  }
  const response = await fetchMedia(url, { signal, headers });
  if (!response.ok) throw new Error(t("Сегмент или манифест недоступен (HTTP $1)", [response.status]));
  if (response.url) await checkPermissions([remote(response.url)]);
  return response;
}

async function readBytes(response, limit, maximum = limit, onBytes = () => {}) {
  const message = t("Поток превышает лимит памяти загрузчика ($1 МБ)", [Math.round(maximum / 1024 / 1024)]);
  if (Number(response.headers.get("Content-Length")) > limit) throw new Error(message);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error(message);
      chunks.push(value);
      onBytes(size);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function manifestAt(url, signal) {
  const response = await request(url, signal);
  const bytes = await readBytes(response, 4 * 1024 * 1024);
  return { text: new TextDecoder().decode(bytes), base: response.url || url };
}

function best(playlists) {
  return [...playlists].sort((a, b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0))[0];
}

function audioGroup(groups) {
  const entries = Object.values(groups || {});
  return entries.find(entry => entry.default) || entries.find(entry => entry.autoselect) || entries[0];
}

async function hlsTracks(url, signal, seen = new Set()) {
  if (seen.has(url) || seen.size >= 8) throw new Error(t("Зацикленный или слишком вложенный HLS-плейлист"));
  seen.add(url);
  const { text, base } = await manifestAt(url, signal);
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error(t("Сайт вернул не HLS-плейлист"));
  const parser = new globalThis.m3u8Parser.Parser(); parser.push(text); parser.end();
  const parsed = parser.manifest;
  if (parsed.playlists?.length) {
    const video = best(parsed.playlists);
    const tracks = await hlsTracks(remote(video.uri, base), signal, seen);
    const audio = audioGroup(parsed.mediaGroups?.AUDIO?.[video.attributes?.AUDIO]);
    if (audio?.uri) tracks.push(...await hlsTracks(remote(audio.uri, base), signal, seen));
    return tracks;
  }
  if (!parsed.segments?.length) throw new Error(t("В HLS пока нет полных сегментов. Запустите видео и повторите загрузку."));
  return [{ playlist: parsed, base, live: !parsed.endList }];
}

function validateDash(document) {
  const duration = value => {
    if (!value) return 0;
    const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!match) throw new Error(t("Некорректная длительность DASH"));
    return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  };
  const root = document.documentElement;
  const span = Math.max(duration(root.getAttribute("mediaPresentationDuration")), ...[...document.getElementsByTagNameNS("*", "Period")].map(period => duration(period.getAttribute("duration"))));
  const liveSpan = Math.max(0, (Date.now() - Date.parse(root.getAttribute("availabilityStartTime"))) / 1000) + duration(root.getAttribute("minimumUpdatePeriod"));
  const integer = (element, name, fallback, minimum) => {
    const value = element.hasAttribute(name) ? Number(element.getAttribute(name)) : fallback;
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(t("Некорректное число $1 в DASH", [name]));
    return value;
  };
  const representations = document.getElementsByTagNameNS("*", "Representation").length;
  if (representations > 256) throw new Error(t("Слишком много представлений DASH"));
  let maximumSegments = 1;
  for (const element of document.getElementsByTagName("*")) {
    for (const attribute of element.attributes) {
      if (attribute.value.length > 8192 || [...attribute.value.matchAll(/%0(\d+)d/g)].some(match => Number(match[1]) > 32)) throw new Error(t("Слишком длинный шаблон DASH"));
    }
    if (!["SegmentTemplate", "SegmentList"].includes(element.localName)) continue;
    if (integer(element, "startNumber", 1, 0) > Number.MAX_SAFE_INTEGER - 20000) throw new Error(t("Слишком большой startNumber DASH"));
    const templates = [element];
    for (let parent = element.parentElement?.parentElement; parent; parent = parent.parentElement) {
      const inherited = [...parent.children].find(child => child.localName === element.localName);
      if (inherited) templates.push(inherited);
    }
    const scale = integer(templates.find(template => template.hasAttribute("timescale")) || element, "timescale", 1, 1);
    const durationTemplate = templates.find(template => template.hasAttribute("duration"));
    const segmentDuration = durationTemplate ? integer(durationTemplate, "duration", 1, 1) : 0;
    const window = duration(root.getAttribute("timeShiftBufferDepth")) || span || liveSpan;
    if (segmentDuration && window * scale / segmentDuration > 20000) throw new Error(t("Слишком много сегментов DASH"));
    if (segmentDuration && Number.isFinite(window)) maximumSegments = Math.max(maximumSegments, Math.ceil(window * scale / segmentDuration));
    maximumSegments = Math.max(maximumSegments, element.getElementsByTagNameNS("*", "SegmentURL").length);
    const timelineTemplate = templates.find(template => template.getElementsByTagNameNS("*", "SegmentTimeline").length);
    for (const timeline of timelineTemplate?.getElementsByTagNameNS("*", "SegmentTimeline") || []) {
      const segments = [...timeline.getElementsByTagNameNS("*", "S")];
      let time = 0; let count = 0;
      for (const [index, segment] of segments.entries()) {
        const d = integer(segment, "d", 0, 1);
        const r = integer(segment, "r", 0, -1);
        time = integer(segment, "t", time, 0);
        const nextTime = segments[index + 1]?.getAttribute("t");
        const end = nextTime ? Number(nextTime) : (span || liveSpan) * scale;
        const repeats = r >= 0 ? r + 1 : Math.ceil((end - time) / d);
        if (!Number.isSafeInteger(repeats) || repeats < 0 || repeats + count > 20000) throw new Error(t("Слишком большой или неограниченный SegmentTimeline DASH"));
        count += repeats; time += repeats * d;
        if (!Number.isSafeInteger(time)) throw new Error(t("Слишком большая временная шкала DASH"));
      }
      maximumSegments = Math.max(maximumSegments, count);
    }
  }
  if (maximumSegments > 20000 || maximumSegments * representations > 200000) throw new Error(t("Слишком много сегментов DASH"));
}

export async function planStream(candidate, { signal, preview = false } = {}) {
  let tracks;
  if (candidate.transport === "dash") {
    const { text, base } = await manifestAt(candidate.url, signal);
    if (/<!DOCTYPE/i.test(text)) throw new Error(t("DASH с DTD не поддерживается"));
    const document = new DOMParser().parseFromString(text, "application/xml");
    if (document.querySelector("parsererror") || document.documentElement.localName !== "MPD") throw new Error(t("Некорректный DASH-манифест"));
    if (document.getElementsByTagNameNS("*", "ContentProtection").length) throw new Error(t("Поток защищён DRM/ContentProtection. Такой поток не загружается."));
    validateDash(document);
    const parsed = globalThis.mpdParser.parse(text, { manifestUri: base });
    const video = best(parsed.playlists || []);
    const audio = audioGroup(parsed.mediaGroups?.AUDIO?.audio);
    const sound = best(audio?.playlists || []);
    tracks = [video, sound].filter(Boolean).map(playlist => ({ playlist, base, live: document.documentElement.getAttribute("type") === "dynamic" }));
    if (!video) throw new Error(t("В DASH не найдена видеодорожка"));
  } else tracks = await hlsTracks(candidate.url, signal);
  const urls = [];
  for (const track of tracks) {
    const { playlist, base } = track;
    if (playlist.sidx && !playlist.segments?.length) track.file = remote(playlist.sidx.resolvedUri || playlist.sidx.uri, base);
    if (track.file) { urls.push(track.file); continue; }
    if (!playlist.segments?.length) throw new Error(t("В дорожке нет доступных сегментов"));
    if (playlist.segments.length > 20000) throw new Error(t("В потоке слишком много сегментов для загрузки в браузере"));
    if (preview) {
      let seconds = 0;
      playlist.segments = playlist.segments.slice(0, 20).filter(segment => {
        const include = seconds < 30;
        seconds += segment.duration || 1;
        return include;
      });
    }
    for (const segment of playlist.segments) {
      if (segment.gap) throw new Error(t("В потоке отсутствуют сегменты. Повторите загрузку позднее."));
      urls.push(remote(segment.resolvedUri || segment.uri, base));
      if (segment.map) urls.push(remote(segment.map.resolvedUri || segment.map.uri, base));
      if (segment.key) {
        if (segment.key.method !== "AES-128" || segment.key.keyFormat && segment.key.keyFormat !== "identity") throw new Error(t("Поток использует DRM/SAMPLE-AES. Поддерживаются открытые потоки и AES-128."));
        urls.push(remote(segment.key.uri, base));
        if (segment.map && !segment.key.iv) throw new Error(t("Зашифрованный init-сегмент HLS не содержит IV"));
      }
    }
  }
  await checkPermissions(urls);
  return { tracks, live: tracks.some(track => track.live) };
}

export function segmentIv(iv, sequence) {
  if (iv) {
    if (iv.length !== 4) throw new Error(t("Некорректный IV HLS"));
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    iv.forEach((value, index) => view.setUint32(index * 4, value));
    return bytes;
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(t("Некорректный номер сегмента HLS"));
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setBigUint64(8, BigInt(sequence));
  return bytes;
}

export async function downloadStream(candidate, { signal, onProgress = () => {}, preview = false } = {}) {
  signal?.throwIfAborted();
  onProgress(t("Чтение плейлиста…"));
  const plan = await planStream(candidate, { signal, preview });
  const { FFmpeg } = await import("../vendor/streaming/index.js");
  signal?.throwIfAborted();
  const ffmpeg = new FFmpeg();
  const abort = () => ffmpeg.terminate();
  signal?.addEventListener("abort", abort, { once: true });
  let downloaded = 0;
  const keys = new Map();
  const total = plan.tracks.reduce((sum, track) => sum + (track.file ? 1 : track.playlist.segments.length), 0);
  let completed = 0;
  async function bytesAt(url, range) {
    signal?.throwIfAborted();
    const response = await request(url, signal, range);
    const maximum = preview ? 64 * 1024 * 1024 : maxBytes;
    let bytes = await readBytes(response, maximum - downloaded, maximum, size => {
      onProgress(t("Загрузка сегментов…"), { loadedBytes: downloaded + size });
    });
    if (range) {
      if (response.status === 206) {
        const expected = `bytes ${range.offset}-${range.offset + range.length - 1}/`;
        if (!response.headers.get("Content-Range")?.startsWith(expected) || bytes.length !== range.length) throw new Error(t("Сервер вернул неверный byte range"));
      } else {
        if (bytes.length < range.offset + range.length) throw new Error(t("Сегмент короче запрошенного byte range"));
        bytes = bytes.slice(range.offset, range.offset + range.length);
      }
    }
    downloaded += bytes.length;
    return bytes;
  }
  async function decrypt(bytes, key, sequence, base) {
    if (!key) return bytes;
    const url = remote(key.uri, base);
    if (!keys.has(url)) {
      const data = await bytesAt(url);
      if (data.length !== 16) throw new Error(t("Некорректный ключ AES-128"));
      keys.set(url, await crypto.subtle.importKey("raw", data, "AES-CBC", false, ["decrypt"]));
    }
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: segmentIv(key.iv, sequence) }, keys.get(url), bytes));
  }
  try {
    onProgress(plan.live ? t("Прямой эфир: сохраняем доступный сейчас фрагмент…") : t("Подготовка сборки видео…"));
    await ffmpeg.load({ coreURL: new URL("../vendor/streaming/ffmpeg-core.js", import.meta.url).href, wasmURL: new URL("../vendor/streaming/ffmpeg-core.wasm", import.meta.url).href });
    signal?.throwIfAborted();
    const inputs = [];
    for (const [trackIndex, track] of plan.tracks.entries()) {
      if (track.file) {
        const name = `track_${trackIndex}.mp4`;
        await ffmpeg.writeFile(name, await bytesAt(track.file)); inputs.push(name); completed++;
        continue;
      }
      const { playlist, base } = track;
      const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...playlist.segments.map(segment => segment.duration || 1))))}`];
      const maps = new Map();
      let currentMap;
      for (const [index, segment] of playlist.segments.entries()) {
        signal?.throwIfAborted();
        const sequence = (playlist.mediaSequence || 0) + index;
        if (segment.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
        if (segment.map) {
          const key = JSON.stringify([segment.map, segment.key]);
          if (!maps.has(key)) {
            const name = `init_${trackIndex}_${maps.size}.mp4`;
            const bytes = await bytesAt(remote(segment.map.resolvedUri || segment.map.uri, base), segment.map.byterange);
            await ffmpeg.writeFile(name, await decrypt(bytes, segment.key, sequence, base)); maps.set(key, name);
          }
          if (currentMap !== key) { lines.push(`#EXT-X-MAP:URI="${maps.get(key)}"`); currentMap = key; }
        }
        const name = `segment_${trackIndex}_${index}.bin`;
        const bytes = await bytesAt(remote(segment.resolvedUri || segment.uri, base), segment.byterange);
        await ffmpeg.writeFile(name, await decrypt(bytes, segment.key, sequence, base));
        lines.push(`#EXTINF:${segment.duration || 1},`, name);
        onProgress(t("Загружено сегментов: $1 из $2$3", [++completed, total, plan.live ? t(" · фрагмент эфира") : ""]));
      }
      lines.push("#EXT-X-ENDLIST");
      const input = `track_${trackIndex}.m3u8`;
      await ffmpeg.writeFile(input, new TextEncoder().encode(lines.join("\n"))); inputs.push(input);
    }
    signal?.throwIfAborted();
    onProgress(t("Объединение видео и звука…"), { loadedBytes: downloaded, totalBytes: downloaded, totalApproximate: false });
    // The bundled core has legacy demuxers with known CVEs; stream copy still parses their headers.
    const formats = "hls,mpegts,mov,matroska,webm,aac,ac3,eac3,mp3,ogg,flac";
    const args = inputs.flatMap(input => ["-protocol_whitelist", "file,crypto,data", "-format_whitelist", formats,
      ...(input.endsWith("m3u8") ? ["-allowed_extensions", "ALL"] : []), "-i", input]);
    args.push("-map", "0:v:0", "-map", inputs.length > 1 ? "1:a:0" : "0:a:0?", "-c", "copy");
    if (preview) args.push("-t", "30");
    let extension = "mp4";
    if (await ffmpeg.exec([...args, "-movflags", "+faststart", "output.mp4"]) !== 0) {
      extension = "webm";
      if (await ffmpeg.exec([...args, "output.webm"]) !== 0) throw new Error(t("Не удалось собрать видео: несовместимые кодеки или повреждённые сегменты"));
    }
    signal?.throwIfAborted();
    const bytes = await ffmpeg.readFile(`output.${extension}`);
    if (!bytes.length) throw new Error(t("Сборщик вернул пустой видеофайл"));
    return new File([bytes], `video${plan.live ? "-live-fragment" : ""}.${extension}`, { type: `video/${extension}` });
  } catch (error) {
    signal?.throwIfAborted();
    throw error instanceof Error ? error : new Error(String(error));
  } finally { signal?.removeEventListener("abort", abort); ffmpeg.terminate(); }
}
