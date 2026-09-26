#!/usr/bin/env node
//
// batch-editor/server.js — local web UI for batch-creating and editing Architypes
// posts.
//
// Serves a single page: a grid of photos found in <repo>/_inbox for creating new
// posts, a scrollable list of existing posts for editing their metadata, and a form
// shared by both. Creating moves the chosen photo into a new
// content/posts/YYYYMMDD_slug/feature.jpg and writes index.md in the same shape as
// archetypes/new-post.sh produces. Editing rewrites an existing post's index.md
// (renaming its folder if the date/slug changed) without touching its photo.
//
// Usage: ./tools/batch-editor/server.js   (run with node, not sh)

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
const DE_DIR = path.join(ROOT, 'content', 'de');
const INBOX_DIR = path.join(ROOT, '_inbox');
const THUMB_DIR = path.join(INBOX_DIR, '.thumbs');
const WEB_DIR = path.join(__dirname, 'web');
const PORT = 4747;

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

// --- helpers -----------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Turn a title into a slug: drop accents, lower-case, hyphenate.
// Mirrors archetypes/new-post.sh's slugify().
function slugify(input) {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Turn a 2-letter country code into its flag emoji (e.g. fr -> \u{1F1EB}\u{1F1F7}).
function flagFor(countryCode) {
  const cc = countryCode.toLowerCase();
  const a = cc.codePointAt(0) - 97 + 0x1f1e6;
  const b = cc.codePointAt(1) - 97 + 0x1f1e6;
  return String.fromCodePoint(a) + String.fromCodePoint(b);
}

// "aout" is spelled without its circumflex throughout the site's existing posts; every
// other accented month is kept as-is. Matches archétype-spelling, not a typo to "fix".
const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'décembre',
];

// Reads a photo's own capture date (via sips, no extra dependency) and turns it into
// the "Photo prise en <mois> <année>." opener nearly every existing post starts with.
function captionHintFor(photoPath) {
  let out;
  try {
    out = execFileSync('sips', ['-g', 'creation', photoPath], { encoding: 'utf8' });
  } catch {
    return null;
  }
  const m = out.match(/creation:\s*(\d{4}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const year = m[1];
  const month = MONTHS_FR[parseInt(m[2], 10) - 1];
  if (!month) return null;
  return `Photo prise en ${month} ${year}. `;
}

function yamlQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function assertSafeName(name) {
  if (!name || typeof name !== 'string' || /[/\\]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw new HttpError(400, `Nom invalide : ${name}`);
  }
}

function listPostDates() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name.match(/^(\d{4})(\d{2})(\d{2})_/))
    .filter(Boolean)
    .map((m) => `${m[1]}-${m[2]}-${m[3]}`)
    .sort();
}

function nextDate() {
  const dates = listPostDates();
  const base = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 3);
  return d.toISOString().slice(0, 10);
}

function listLocations() {
  if (!fs.existsSync(DE_DIR)) return [];
  return fs
    .readdirSync(DE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      let title = e.name;
      try {
        const text = fs.readFileSync(path.join(DE_DIR, e.name, '_index.md'), 'utf8');
        const m = text.match(/^title:\s*"?(.*?)"?\s*$/m);
        if (m) title = m[1];
      } catch {
        // no _index.md yet; fall back to the slug itself
      }
      const city = title.replace(/\s*[\u{1F1E6}-\u{1F1FF}]{2}\s*$/gu, '').trim();
      return { slug: e.name, title, city };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

const IMAGE_RE = /\.(jpe?g|png|heic|tiff?)$/i;

function listInbox() {
  return fs
    .readdirSync(INBOX_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_RE.test(e.name))
    .map((e) => {
      const stat = fs.statSync(path.join(INBOX_DIR, e.name));
      return { filename: e.name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.filename.localeCompare(b.filename));
}

// Parses the fixed title/date/de/body shape every post's index.md is written in.
function parseFrontMatter(text) {
  const titleM = text.match(/^title:\s*"((?:[^"\\]|\\.)*)"\s*$/m);
  const dateM = text.match(/^date:\s*(\S+)\s*$/m);
  const deBlockM = text.match(/^de:\n((?:\s*-\s*"[^"]*"\n?)+)/m);
  const bodyM = text.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);

  let de = '';
  if (deBlockM) {
    const first = deBlockM[1].match(/-\s*"([^"]*)"/);
    if (first) de = first[1];
  }

  return {
    title: titleM ? titleM[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '',
    date: dateM ? dateM[1] : '',
    de,
    body: bodyM ? bodyM[1].trim() : '',
  };
}

// Lightweight summary of every post, for the "browse and edit" list — newest first.
function listPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      let title = e.name;
      let date = '';
      try {
        const parsed = parseFrontMatter(fs.readFileSync(path.join(POSTS_DIR, e.name, 'index.md'), 'utf8'));
        title = parsed.title || title;
        date = parsed.date;
      } catch {
        // no index.md — still list the folder so it isn't silently invisible
      }
      return { dirName: e.name, title, date: date.slice(0, 10) };
    })
    .sort((a, b) => (a.dirName < b.dirName ? 1 : a.dirName > b.dirName ? -1 : 0));
}

// Full editable data for one post. The title stored on disk already includes the
// "(City)" suffix; this splits it back into the bare venue name (what the title field
// should show) so re-saving without touching anything reproduces the same file.
function getPost(dirName) {
  assertSafeName(dirName);
  const file = path.join(POSTS_DIR, dirName, 'index.md');
  if (!fs.existsSync(file)) throw new HttpError(404, 'Architype introuvable.');

  const parsed = parseFrontMatter(fs.readFileSync(file, 'utf8'));
  if (!parsed.title) throw new HttpError(500, `Impossible de lire le titre de ${dirName}.`);

  let city = null;
  if (parsed.de) {
    const loc = listLocations().find((l) => l.slug === parsed.de);
    city = loc ? loc.city : null;
  }

  let venue = parsed.title;
  if (city && venue.endsWith(` (${city})`)) {
    venue = venue.slice(0, venue.length - (city.length + 3));
  }

  const dateMatch = parsed.date.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);

  return {
    dirName,
    venue,
    de: parsed.de,
    date: dateMatch ? dateMatch[1] : parsed.date.slice(0, 10),
    time: dateMatch ? dateMatch[2] : '15:00',
    caption: parsed.body,
  };
}

function thumbPathFor(cacheKey) {
  const hash = crypto.createHash('sha1').update(cacheKey).digest('hex').slice(0, 16);
  return path.join(THUMB_DIR, hash + '.jpg');
}

function ensureThumb(sourcePath, cacheKey) {
  const thumb = thumbPathFor(cacheKey);
  const srcStat = fs.statSync(sourcePath);
  if (fs.existsSync(thumb) && fs.statSync(thumb).mtimeMs >= srcStat.mtimeMs) {
    return thumb;
  }
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.copyFileSync(sourcePath, thumb);
  execFileSync('sips', ['-Z', '480', thumb], { stdio: 'ignore' });
  return thumb;
}

function commitPhoto(filename, destDir) {
  const src = path.join(INBOX_DIR, filename);
  const destPath = path.join(destDir, 'feature.jpg');
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    fs.renameSync(src, destPath);
  } else {
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', destPath], { stdio: 'ignore' });
    fs.unlinkSync(src);
  }
  fs.rmSync(thumbPathFor(`inbox:${filename}`), { force: true });
}

// --- post creation / editing ---------------------------------------------

// Resolves the "de" taxonomy slug to use: either an existing one picked from the
// dropdown, or a brand new term created inline (same shape as new-post.sh's own
// inline location creation).
function resolveLocation(deSlug, newLocation) {
  let de = deSlug || '';
  if (newLocation && newLocation.city && newLocation.countryCode) {
    const cc = newLocation.countryCode.toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) throw new HttpError(400, 'Code pays invalide (2 lettres).');
    de = `${slugify(newLocation.city)}-${cc}`;
    const termDir = path.join(DE_DIR, de);
    if (!fs.existsSync(termDir)) {
      fs.mkdirSync(termDir, { recursive: true });
      fs.writeFileSync(
        path.join(termDir, '_index.md'),
        `---\ntitle: ${yamlQuote(`${newLocation.city} ${flagFor(cc)}`)}\n---\n`
      );
    }
  }
  return de;
}

// Validates and normalizes the fields shared by create and edit.
function parseCommonFields(body) {
  const cleanTitle = (body.title || '').trim();
  if (!cleanTitle) throw new HttpError(400, 'Le titre est obligatoire.');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) throw new HttpError(400, 'Date invalide.');
  const cleanTime = /^\d{2}:\d{2}$/.test(body.time || '') ? body.time : '15:00';
  const stamp = `${body.date}T${cleanTime}:00Z`;
  const ymd = body.date.replace(/-/g, '');

  const de = resolveLocation(body.deSlug, body.newLocation);

  const slug = (body.slug && body.slug.trim()) || slugify(cleanTitle);
  if (!slug) throw new HttpError(400, 'Impossible de déduire un slug.');

  return { cleanTitle, stamp, ymd, de, slug, caption: body.caption };
}

function frontMatterFor(title, stamp, de, slug, caption) {
  let fm = '---\n';
  fm += `title: ${yamlQuote(title)}\n`;
  fm += `date: ${stamp}\n`;
  if (de) fm += `de:\n  - ${yamlQuote(de)}\n`;
  fm += `slug: ${yamlQuote(slug)}\n`;
  fm += '---\n\n';
  fm += (caption || '').trim() + '\n';
  return fm;
}

function createPost(body) {
  const { photoFilename } = body;
  assertSafeName(photoFilename);
  const srcPath = path.join(INBOX_DIR, photoFilename);
  if (!fs.existsSync(srcPath)) throw new HttpError(400, 'Photo introuvable dans _inbox.');

  const { cleanTitle, stamp, ymd, de, slug, caption } = parseCommonFields(body);

  const dirName = `${ymd}_${slug}`;
  const destDir = path.join(POSTS_DIR, dirName);
  if (fs.existsSync(destDir)) throw new HttpError(409, `${dirName} existe déjà.`);

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'index.md'), frontMatterFor(cleanTitle, stamp, de, slug, caption));
  commitPhoto(photoFilename, destDir);

  return { ok: true, dirName, deSlug: de, nextDate: nextDate() };
}

// Rewrites an existing post's metadata. Renames its folder if the date/slug changed
// (carrying feature.jpg along automatically) but never touches the photo itself.
function updatePost(dirName, body) {
  assertSafeName(dirName);
  const oldDir = path.join(POSTS_DIR, dirName);
  if (!fs.existsSync(oldDir) || !fs.statSync(oldDir).isDirectory()) {
    throw new HttpError(404, 'Architype introuvable.');
  }

  const { cleanTitle, stamp, ymd, de, slug, caption } = parseCommonFields(body);

  const newDirName = `${ymd}_${slug}`;
  const newDir = path.join(POSTS_DIR, newDirName);
  if (newDirName !== dirName) {
    if (fs.existsSync(newDir)) throw new HttpError(409, `${newDirName} existe déjà.`);
    fs.renameSync(oldDir, newDir);
  }

  fs.writeFileSync(path.join(newDir, 'index.md'), frontMatterFor(cleanTitle, stamp, de, slug, caption));

  return { ok: true, dirName: newDirName, deSlug: de, nextDate: nextDate() };
}

// --- HTTP layer ----------------------------------------------------------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(data);
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/') {
    return serveFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJSON(res, 200, {
      nextDate: nextDate(),
      locations: listLocations(),
      inbox: listInbox(),
      history: listPosts(),
      postCount: listPostDates().length,
      inboxDir: INBOX_DIR,
    });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/thumb/')) {
    const filename = decodeURIComponent(pathname.slice('/api/thumb/'.length));
    assertSafeName(filename);
    const src = path.join(INBOX_DIR, filename);
    if (!fs.existsSync(src)) return sendJSON(res, 404, { error: 'not found' });
    return serveFile(res, ensureThumb(src, `inbox:${filename}`), 'image/jpeg');
  }

  if (req.method === 'GET' && pathname.startsWith('/api/caption-hint/')) {
    const filename = decodeURIComponent(pathname.slice('/api/caption-hint/'.length));
    assertSafeName(filename);
    const src = path.join(INBOX_DIR, filename);
    if (!fs.existsSync(src)) return sendJSON(res, 404, { error: 'not found' });
    return sendJSON(res, 200, { text: captionHintFor(src) });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/post-thumb/')) {
    const dirName = decodeURIComponent(pathname.slice('/api/post-thumb/'.length));
    assertSafeName(dirName);
    const src = path.join(POSTS_DIR, dirName, 'feature.jpg');
    if (!fs.existsSync(src)) return sendJSON(res, 404, { error: 'not found' });
    return serveFile(res, ensureThumb(src, `post:${dirName}`), 'image/jpeg');
  }

  if (req.method === 'GET' && pathname.startsWith('/api/post/')) {
    const dirName = decodeURIComponent(pathname.slice('/api/post/'.length));
    return sendJSON(res, 200, getPost(dirName));
  }

  if (req.method === 'POST' && pathname === '/api/posts') {
    const body = await readJSON(req);
    return sendJSON(res, 200, createPost(body));
  }

  if (req.method === 'POST' && pathname.startsWith('/api/post/')) {
    const dirName = decodeURIComponent(pathname.slice('/api/post/'.length));
    const body = await readJSON(req);
    return sendJSON(res, 200, updatePost(dirName, body));
  }

  sendJSON(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) {
      sendJSON(res, err.status, { error: err.message });
    } else {
      console.error(err);
      sendJSON(res, 500, { error: err.message });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Batch editor running at ${url}`);
  console.log(`Drop exported photos in ${INBOX_DIR}`);
  try {
    execFileSync('open', [url]);
  } catch {
    // not on macOS, or no GUI available — the URL above still works
  }
});
