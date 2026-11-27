// Local stand-in for the R2/CDN media host: CORS, HLS/CMAF MIME types, byte ranges, immutable caching.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const root = join(process.cwd(), 'out');
const port = Number(process.env.PORT || 5174);
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8' };

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = normalize(join(root, decodeURIComponent(url.pathname)));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  res.setHeader('Timing-Allow-Origin', '*');
  if (!path.startsWith(root)) return res.writeHead(403).end();
  let st;
  try {
    st = statSync(path);
    if (!st.isFile()) throw 0;
  } catch {
    return res.writeHead(404).end();
  }
  const type = TYPES[extname(path)] || 'application/octet-stream';
  const cache = extname(path) === '.m3u8' ? 'public, max-age=300' : 'public, max-age=31536000, immutable';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': cache });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cache });
  createReadStream(path).pipe(res);
}).listen(port, () => console.log(`media → http://127.0.0.1:${port}`));
