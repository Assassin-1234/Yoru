// Production build: copies the site into dist/ and stamps every JS/CSS URL with a content hash,
// so CDN/browser caches (Cloudflare rewrites Cache-Control on static assets) can never serve stale code.
// ES module imports are versioned through an import map, so the source files stay untouched.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const hash = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex').slice(0, 10);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const dir of ['assets', 'css', 'js', 'streams']) cpSync(join(root, dir), join(dist, dir), { recursive: true });

// Every build also writes each JS/CSS file under its own content-hashed NAME (util.3f2a….js). Deploys only add
// files, so a page loaded before a deploy keeps fetching exactly the code it shipped with and never mixes versions.
// The ?v= query stays because nginx marks ?v= URLs immutable.
const versioned = (file) => {
  const h = hash(file);
  const out = file.replace(/\.(js|css)$/, `.${h}.$1`);
  cpSync(join(root, file), join(dist, out));
  return `/${out}?v=${h}`;
};
const modules = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js'));
const imports = Object.fromEntries(modules.map((f) => [`/js/${f}`, versioned(`js/${f}`)]));
// Preload hints let the browser fetch every module in parallel instead of discovering them import by import.
const preloads = Object.values(imports).map((u) => `<link rel="modulepreload" href="${u}">`).join('\n  ');
const importMap = `<script type="importmap">${JSON.stringify({ imports })}</script>\n  ${preloads}`;

let html = readFileSync(join(root, 'index.html'), 'utf8');
const cssUrls = ['css/app.css', 'css/player.css'].map((css) => {
  const url = versioned(css);
  html = html.replace(`href="${css}"`, `href="${url}"`);
  return url;
});
// Build id: open tabs compare it with /version.txt and pick up a new deploy on their next navigation.
const build = createHash('sha256').update(JSON.stringify([imports, cssUrls])).digest('hex').slice(0, 12);
html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="yoru-build" content="${build}">`);
if (!html.includes('name="yoru-build"')) throw new Error('build: could not stamp the build id');
writeFileSync(join(dist, 'version.txt'), build + '\n');
// The import map must precede the first module script.
html = html.replace('<script type="module" src="js/main.js"></script>', `${importMap}\n  <script type="module" src="${imports['/js/main.js']}"></script>`);
if (!html.includes('type="importmap"')) throw new Error('build: could not inject the import map');
writeFileSync(join(dist, 'index.html'), html);

console.log(`dist/ ready — ${modules.length} modules versioned, build ${build}`);
