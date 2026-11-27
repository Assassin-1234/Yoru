// Premium HLS packager for YORU's demo reels.
// One ffmpeg pass per title: split → scale → NVENC H.264 per rung (aligned 2 s GOPs, closed, no scenecut),
// one shared AAC rendition, CMAF/fMP4 segments of 2 s, and a multivariant master playlist.
//   node encode.mjs <id> <source> <fps> <width> <height> [maxRung] [audioIndex] [surround:0|1]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [id, src, fpsArg, wArg, hArg, maxArg, audioArg = '0', surroundArg = '0'] = process.argv.slice(2);
const audioIn = `0:a:${Number(audioArg)}`;
const surround = surroundArg === '1';
const fps = Number(fpsArg);
const W = Number(wArg);
const H = Number(hArg);
// CODEC=hevc → 10-bit HEVC (Main10) ladder in out/<id>/hevc at ~70% of the H.264 bitrates (same or better quality).
const HEVC = process.env.CODEC === 'hevc';
// Per-title encoding: RATE scales the whole ladder for content that needs more bits (e.g. grainy live action).
const RATE = Number(process.env.RATE || 1);
const out = join(process.cwd(), 'out', id, ...(HEVC ? ['hevc'] : []));
mkdirSync(out, { recursive: true });

// Rungs by target *height of a 16:9 frame*; wider films keep their aspect (height scales down accordingly).
// kbps chosen for animation/CG at these resolutions (high quality, well above typical streaming ladders).
// Sized to what the masters actually hold (BBB 4K60 master is ~8 Mbps H.264; 1080p films ~8 Mbps).
const LADDER = [
  { name: '2160p', h: 2160, kbps: 11000, fps60: true },
  { name: '1440p', h: 1440, kbps: 7000, fps60: true },
  { name: '1080p', h: 1080, kbps: 4800, fps60: true },
  { name: '720p', h: 720, kbps: 2700, fps60: true },
  { name: '540p', h: 540, kbps: 1400, fps60: false },
  { name: '360p', h: 360, kbps: 650, fps60: false },
];
const max = Number(maxArg || 2160);
const rungs = LADDER.filter((r) => r.h <= max && r.h <= Math.round((W * 9) / 16) + 8);
const even = (n) => 2 * Math.round(n / 2);
const gop = (f) => Math.round(f * 2); // 2-second segments, every segment starts on an IDR

const filters = [`[0:v]split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')}`];
const maps = [];
const varmap = [];
rungs.forEach((r, i) => {
  const outW = even((r.h * 16) / 9);
  const scaledW = Math.min(outW, W);
  const scaledH = even((scaledW * H) / W);
  const f = fps > 30 && !r.fps60 ? fps / 2 : fps;
  filters.push(`[s${i}]${f !== fps ? `fps=${f},` : ''}scale=${scaledW}:${scaledH}:flags=lanczos,format=${HEVC ? 'p010le' : 'yuv420p'}[v${i}]`);
  r.out = { w: scaledW, h: scaledH, fps: f };
  maps.push(
    '-map', `[v${i}]`,
    `-c:v:${i}`, HEVC ? 'hevc_nvenc' : 'h264_nvenc', `-preset:v:${i}`, 'p7', `-tune:v:${i}`, 'hq', `-profile:v:${i}`, HEVC ? 'main10' : 'high',
    ...(HEVC ? [`-tag:v:${i}`, 'hvc1'] : []),
    `-rc:v:${i}`, 'vbr', `-cq:v:${i}`, '18',
    `-b:v:${i}`, `${Math.round(r.kbps * RATE * (HEVC ? 0.7 : 1))}k`, `-maxrate:v:${i}`, `${Math.round(r.kbps * RATE * 1.6 * (HEVC ? 0.7 : 1))}k`, `-bufsize:v:${i}`, `${Math.round(r.kbps * RATE * 2 * (HEVC ? 0.7 : 1))}k`,
    `-g:v:${i}`, String(gop(f)), `-keyint_min:v:${i}`, String(gop(f)), `-forced-idr:v:${i}`, '1', `-no-scenecut:v:${i}`, '1',
    `-bf:v:${i}`, '3', `-b_ref_mode:v:${i}`, HEVC ? 'disabled' : 'middle', `-spatial-aq:v:${i}`, '1', `-temporal-aq:v:${i}`, '1', `-rc-lookahead:v:${i}`, '32',
  );
  varmap.push(`v:${i},agroup:aud,name:${r.name}`);
});
// Stereo (default) plus, where the master has it, a 5.1 surround rendition the viewer can pick in Audio.
maps.push('-map', audioIn, '-c:a:0', 'aac', '-b:a:0', '192k', '-ac:a:0', '2', '-ar:a:0', '48000');
varmap.push('a:0,agroup:aud,name:stereo,default:yes,language:en');
if (surround) {
  maps.push('-map', audioIn, '-c:a:1', 'aac', '-b:a:1', '384k', '-ac:a:1', '6', '-ar:a:1', '48000');
  varmap.push('a:1,agroup:aud,name:surround,language:en');
}

const args = [
  '-hide_banner', '-y', '-loglevel', 'warning', '-stats',
  ...(process.env.TEST ? ['-t', process.env.TEST] : []),
  '-i', src,
  '-filter_complex', filters.join(';'),
  ...maps,
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
  '-hls_flags', 'independent_segments', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', join(out, '%v', 's%04d.m4s'),
  '-master_pl_name', 'master.m3u8',
  '-var_stream_map', varmap.join(' '),
  join(out, '%v', 'index.m3u8'),
];
console.log(`encoding ${id}: ${rungs.map((r) => `${r.name}@${r.out.fps}`).join(', ')}`);
const t0 = Date.now();
const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

// ffmpeg drops the per-variant init segments (init_N.mp4) in the working directory; move each into its variant's
// folder as init.mp4 and point the playlist at it. N follows the var_stream_map order: video rungs, then audio.
const { renameSync, existsSync: has } = await import('node:fs');
const folders = [...rungs.map((r) => r.name), 'stereo', ...(surround ? ['surround'] : [])];
folders.forEach((dir, n) => {
  const from = [join(process.cwd(), `init_${n}.mp4`), join(out, `init_${n}.mp4`)].find((f) => has(f));
  if (!from) throw new Error(`missing init_${n}.mp4 for ${dir}`);
  renameSync(from, join(out, dir, 'init.mp4'));
  const pl = join(out, dir, 'index.m3u8');
  writeFileSync(pl, readFileSync(pl, 'utf8').replace(`URI="init_${n}.mp4"`, 'URI="init.mp4"'));
});

// Rewrite the master playlist properly: forward slashes, real per-rendition bitrates measured from the encoded
// segments (ffmpeg advertises its theoretical peak, which makes ABR needlessly timid), frame rates, track names.
const { readdirSync, statSync } = await import('node:fs');
const SEG = 2;
const measure = (dir) => {
  const files = readdirSync(join(out, dir)).filter((f) => f.endsWith('.m4s'));
  const bits = files.map((f) => statSync(join(out, dir, f)).size * 8 / SEG);
  return { avg: Math.round(bits.reduce((a, b) => a + b, 0) / bits.length), peak: Math.round(Math.max(...bits)) };
};
const audio = measure('stereo');
const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Stereo",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",CHANNELS="2",URI="stereo/index.m3u8"');
if (surround) lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="5.1 Surround",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="en",CHANNELS="6",URI="surround/index.m3u8"');
// RFC 6381 codec string straight from the avcC box: profile, constraint flags and level as the decoder sees them.
const codecOf = (name) => {
  const buf = readFileSync(join(out, name, 'init.mp4'));
  const hex = (b) => b.toString(16).padStart(2, '0');
  const avc = buf.indexOf('avcC');
  if (avc >= 0) return `avc1.${hex(buf[avc + 5])}${hex(buf[avc + 6])}${hex(buf[avc + 7])},mp4a.40.2`;
  const h = buf.indexOf('hvcC');
  if (h < 0) return 'avc1.640028,mp4a.40.2';
  const b = h + 4; // configurationVersion at b
  const ptl = buf[b + 1];
  const space = ['', 'A', 'B', 'C'][ptl >> 6];
  const tier = ptl & 0x20 ? 'H' : 'L';
  const profile = ptl & 0x1f;
  let compat = buf.readUInt32BE(b + 2);
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = [...buf.subarray(b + 6, b + 12)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const level = buf[b + 12];
  return `hvc1.${space}${profile}.${(rev >>> 0).toString(16)}.${tier}${level}${cons.map((c) => '.' + c.toString(16).toUpperCase()).join('')},mp4a.40.2`;
};
for (const r of rungs) {
  const m = measure(r.name);
  lines.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${m.peak + audio.peak},AVERAGE-BANDWIDTH=${m.avg + audio.avg},RESOLUTION=${r.out.w}x${r.out.h},FRAME-RATE=${r.out.fps.toFixed(3)},CODECS="${codecOf(r.name)}",AUDIO="aud"`,
    `${r.name}/index.m3u8`
  );
  console.log(`  ${r.name.padEnd(6)} ${r.out.w}x${r.out.h}@${r.out.fps}  avg ${(m.avg / 1e6).toFixed(2)} Mbps  peak ${(m.peak / 1e6).toFixed(2)} Mbps`);
}
writeFileSync(join(out, 'master.m3u8'), lines.join('\n') + '\n');
console.log(`done ${id} in ${Math.round((Date.now() - t0) / 1000)} s`);
