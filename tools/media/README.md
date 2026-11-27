# YORU media pipeline

How YORU turns a master file into streams. Use it for every title, demo or licensed, so they all meet the same bar.

## What it produces

For each title, `out/<title>/` holds:

- **An H.264 ladder** (`master.m3u8`). This plays everywhere.
  - Up to 6 renditions: 2160p60, 1440p60, 1080p60, 720p60, 540p and 360p. A ladder never goes above the source resolution, and a 24fps master stays at 24fps.
  - NVENC encoder at preset `p7`, tuned for quality, with spatial and temporal AQ and B-frames.
- **An HEVC ladder** (`hevc/master.m3u8`). It's 10-bit, which removes the banding in gradients like skies and fog, at about 70% of the H.264 bitrates. The player picks it only where `navigator.mediaCapabilities` reports smooth, power-efficient (hardware) decoding.
- **Segments.** Both ladders use 2-second CMAF/fMP4 segments, and every segment starts on an IDR frame with aligned GOPs. That keeps the first frame small and makes switching quality clean.
- **Audio.** It's shared AAC: stereo by default, plus a 5.1 surround rendition when the master has one.
- **Master playlists** carry *measured* `BANDWIDTH` (peak) and `AVERAGE-BANDWIDTH` per rendition, plus `FRAME-RATE`. They also carry exact RFC 6381 codec strings, read from each `avcC`/`hvcC` box.
- **Subtitles.** These are WebVTT files in `subs/<lang>.vtt`.

## Encode

Run these from a working folder that contains `src/`:

```bash
# node encode.mjs <id> <source> <fps> <width> <height> <maxRung> <audioIndex> <surround 0|1>
node encode.mjs big-buck-bunny src/bbb_sunflower_2160p_60fps_normal.mp4 60 3840 2160 2160 1 1
CODEC=hevc node encode.mjs big-buck-bunny src/bbb_sunflower_2160p_60fps_normal.mp4 60 3840 2160 2160 1 1
python srt2vtt.py subs/episode.en.srt out/<id>/subs/en.vtt     # tolerates '->' arrows and BOMs
```

`TEST=20` encodes just the first 20 seconds, which is useful for checking settings.

## Serve and test locally

`node serve.mjs` serves `out/` on port 5174, with CORS, byte ranges and the right MIME types. In the site's console, run:

```js
localStorage.setItem('yoru:media', 'http://127.0.0.1:5174')
```

## Publish

The media lives on **Cloudflare Pages**, Cloudflare's developer platform. Its terms allow serving video from a free account, it needs no payment method, and its bandwidth is unlimited. A deployment can hold up to 20,000 files, of 25 MB each at most.

```bash
cp pages-headers.txt out/_headers      # immutable segments, 5-minute playlists, CORS, Timing-Allow-Origin
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler@3 pages deploy out --project-name yoru-media --branch main
```

Then set `"media": "https://<host>"` (and `"mediaHevc": true`) in `streams/catalog.json`, and deploy the site.

**Always use a new folder name when you re-encode a title** (for example `sintel` becomes `sintel-4k`), and update its `key` in `js/sources.js`. Segments are served `immutable`, so browsers keep them for a year. If a new encode reused old paths, a returning viewer could end up mixing cached old segments with new init segments, and playback would break.
