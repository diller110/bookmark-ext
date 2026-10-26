# Streaming runtimes

All executable assets are local. `FFmpeg.load` always receives local core/WASM URLs; no CDN code is loaded at runtime.

The wrapper has a local-only adaptation for this extension: its worker statically imports the bundled core, and core/WASM/worker URLs must exactly match the bundled files. The upstream CDN fallback and unused nested worker loader are removed. `scripts/vendor-streaming.mjs` applies this patch after verifying pinned tarballs, and fails if the expected upstream code changes. Copyright and license notices are retained. The native core binary is unchanged; format/protocol restrictions are applied by the extension before each FFmpeg input.

| Package | Version | Purpose | License |
| --- | --- | --- | --- |
| `m3u8-parser` | 7.2.0 | HLS master/media playlists | Apache-2.0 |
| `mpd-parser` | 1.4.0 | DASH templates, timelines, lists and base segments | Apache-2.0 |
| `@ffmpeg/ffmpeg` | 0.12.15 | Module worker interface | MIT |
| `@ffmpeg/core` | 0.12.10 | Single-thread WASM remuxing | GPL-2.0-or-later |

The core WASM is about 32 MB. It is loaded only when downloading a segmented stream. Single-thread core does not require SharedArrayBuffer or cross-origin isolation. Parsers are official browser bundles; `mpd-parser` uses the browser DOMParser. `package.json` marks this directory as ESM for the worker/modules and tests.

Reproduce the vendored files with `node scripts/vendor-streaming.mjs` from the project root. The script downloads pinned npm tarballs, verifies their SHA-512 integrity before extraction, and copies their official distribution files. No npm installation or build step is required to run the extension. Runtime binary/package metadata and license texts are included here.

Official sources and build instructions:

- [m3u8-parser v7.2.0](https://github.com/videojs/m3u8-parser/tree/v7.2.0).
- [mpd-parser v1.4.0](https://github.com/videojs/mpd-parser/tree/v1.4.0).
- [FFmpeg wrapper v12.15](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15/packages/ffmpeg).
- [FFmpeg core 0.12.10 source/build](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10).
- [FFmpeg.wasm usage](https://ffmpegwasm.netlify.app/docs/getting-started/usage/).

The JavaScript wrapper's MIT license does not replace the core's GPL license. Preserve the license notices and corresponding-source/build information when distributing the bundled core.
