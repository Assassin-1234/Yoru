// Zero-dependency static server:  node server.mjs  →  http://localhost:5173
// (YouTube embeds refuse to play from file://, so open the site through this.)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleZoko } from './zoko.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (await handleZoko(req, res)) return;
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 403 });
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 403 ? 403 : 404, { 'Content-Type': 'text/plain' });
    res.end(err.code === 403 ? 'Forbidden' : 'Not found');
  }
}).listen(port, () => console.log(`YORU is running → http://localhost:${port}`));
