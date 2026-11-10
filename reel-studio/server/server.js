#!/usr/bin/env node
/*
 * Reel Maker Studio — backend.
 *
 * Zero dependencies (Node 18+). Run:  node server/server.js   (or npm start)
 *
 * The backend is built on the DSLAB experiments (ported in public/js/ds.js,
 * which this server loads too, so browser and server share one implementation):
 *
 *   /api/media      Exp 1 array insert/delete, Exp 2 linear search,
 *                   Exp 8/9/10/12 insertion / quick / merge / heap sort
 *   /api/jobs       Exp 7 linked-list queue (AI generations run FIFO)
 *   /api/hashtags   Exp 11 binary search tree (prefix suggestions)
 *   /api/autoreel   Exp 13.1 BFS / Exp 13.2 DFS over a scene graph
 *   /api/eval       Exp 6 infix -> postfix evaluation
 *   /api/projects   saved timelines (Exp 4 doubly linked list, serialised)
 *
 * AI generation goes through MuAPI (client adapted from open-generative-ai).
 * The key is read from the MUAPI_KEY env var or saved via /api/settings, and
 * never sent to the browser.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

require('../public/js/ds.js');
const DS = globalThis.DS;
const { MuapiClient, MODELS } = require('./muapi.js');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PROJECT_DIR = path.join(DATA_DIR, 'projects');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
  '.ico': 'image/x-icon',
};
const EXT_FOR = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m.split(';')[0], e]));

/* ------------------------------------------------------------------ state */
for (const d of [DATA_DIR, MEDIA_DIR, PROJECT_DIR]) fs.mkdirSync(d, { recursive: true });

const library = new DS.MediaLibrary(); // Exp 1
try { JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')).forEach((it) => library.push(it)); } catch (e) { /* first run */ }

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { /* none yet */ }
const getKey = () => process.env.MUAPI_KEY || settings.muapiKey || '';
const muapi = new MuapiClient(getKey);

let saveTimer = null;
function saveLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fsp.writeFile(LIBRARY_FILE, JSON.stringify(library.display(), null, 1)).catch(console.error), 150);
}

// Hashtag bank — Exp 11 BST
const hashtags = new DS.BST();
['reels', 'reelsinstagram', 'reelitfeelit', 'explore', 'explorepage', 'viral', 'trending', 'fyp', 'foryou', 'instagood',
  'photooftheday', 'travel', 'travelgram', 'wanderlust', 'food', 'foodie', 'foodporn', 'fitness', 'gym', 'workout',
  'fashion', 'style', 'ootd', 'beauty', 'makeup', 'music', 'dance', 'art', 'artist', 'design', 'nature', 'sunset',
  'beach', 'summer', 'love', 'happy', 'friends', 'family', 'motivation', 'inspiration', 'tech', 'coding', 'developer',
  'ai', 'aiart', 'generativeai', 'startup', 'business', 'marketing', 'smallbusiness', 'tutorial', 'howto', 'diy',
  'comedy', 'funny', 'memes', 'pets', 'dog', 'cat', 'gaming', 'cinematic', 'vlog', 'dayinmylife', 'tbt', 'weekend',
  'coffee', 'recipe', 'healthy', 'yoga', 'photography', 'film', 'behindthescenes', 'newpost', 'trend', 'transition',
].forEach((t) => hashtags.insert(t));

// AI jobs — Exp 7 queue
const jobQueue = new DS.Queue();
const jobs = new Map(); // id -> job (for status lookups)
let workerBusy = false;

/* ---------------------------------------------------------------- helpers */
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const ok = (res, body) => send(res, 200, body);
const fail = (res, status, message) => send(res, status, { error: message });

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function kindOf(mime) {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}
function safeName(s) { return String(s || 'untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 120) || 'untitled'; }

const SORTS = { // Exp 8, 9, 10, 12
  newest: (a) => DS.insertionSort(a, (x) => -(x.createdAt || 0)),
  duration: (a) => DS.quickSort(a, (x) => x.duration || 0),
  name: (a) => DS.mergeSort(a, (x) => x.name.toLowerCase()),
  size: (a) => DS.heapSort(a, (x) => -(x.size || 0)),
};

function addMediaItem(item) {
  library.insert(0, item); // newest first (Exp 1 insert at position 0)
  saveLibrary();
  return item;
}

/* --------------------------------------------------------------- AI worker */
function enqueueJob(spec) {
  const job = { id: uid('job'), ...spec, status: 'queued', message: 'Waiting in queue', createdAt: Date.now(), mediaId: null, error: null };
  jobs.set(job.id, job);
  jobQueue.enqueue(job);
  runWorker();
  return job;
}

async function runWorker() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    while (!jobQueue.isEmpty()) {
      const job = jobQueue.dequeue();
      if (job.status === 'cancelled') continue;
      job.status = 'running'; job.message = 'Starting';
      const onStatus = (m) => { job.message = m; };
      try {
        let result;
        if (job.type === 'image') result = await muapi.generateImage(job, onStatus);
        else if (job.type === 'video') result = await muapi.generateVideo(job, onStatus);
        else if (job.type === 'animate') {
          const src = library.get(job.sourceId);
          if (!src) throw new Error('Source image not found');
          onStatus('Uploading source image');
          const buf = await fsp.readFile(path.join(MEDIA_DIR, src.file));
          const image_url = await muapi.uploadBuffer(buf, src.name, src.mime);
          result = await muapi.animateImage({ ...job, image_url }, onStatus);
        } else throw new Error('Unknown job type');
        if (!result.url) throw new Error('MuAPI returned no output URL');

        onStatus('Downloading result');
        const r = await fetch(result.url);
        if (!r.ok) throw new Error(`Could not download result (${r.status})`);
        const mime = (r.headers.get('content-type') || '').split(';')[0] || (job.type === 'image' ? 'image/png' : 'video/mp4');
        const ext = EXT_FOR[mime] || path.extname(new URL(result.url).pathname) || (job.type === 'image' ? '.png' : '.mp4');
        const id = uid('m');
        const file = id + ext;
        const buf = Buffer.from(await r.arrayBuffer());
        await fsp.writeFile(path.join(MEDIA_DIR, file), buf);
        const item = addMediaItem({
          id, file, mime, size: buf.length, kind: job.type === 'image' ? 'image' : 'video',
          name: job.prompt.slice(0, 48), prompt: job.prompt, source: 'ai', model: job.model,
          duration: job.type === 'image' ? 0 : Number(job.duration) || 0, createdAt: Date.now(),
        });
        job.mediaId = item.id; job.status = 'done'; job.message = 'Added to library';
      } catch (e) {
        job.status = 'failed'; job.error = e.message; job.message = e.message;
      }
    }
  } finally { workerBusy = false; }
}

/* ------------------------------------------------------------ static files */
async function serveFile(req, res, file, { immutable = false } = {}) {
  let stat;
  try { stat = await fsp.stat(file); if (!stat.isFile()) throw new Error('dir'); }
  catch (e) { return fail(res, 404, 'Not found'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
  const range = req.headers.range;
  if (range) { // Range support so <video> can seek
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = stat.size - parseInt(m[2], 10); end = stat.size - 1; }
    if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function insideDir(dir, rel) {
  const p = path.resolve(dir, '.' + path.sep + rel);
  return p === dir || p.startsWith(dir + path.sep) ? p : null;
}

/* ------------------------------------------------------------------ routes */
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const [resource, id] = parts;
  const method = req.method;

  if (resource === 'health') return ok(res, { ok: true, items: library.n, hasKey: !!getKey() });

  if (resource === 'settings') {
    if (method === 'GET') return ok(res, { hasKey: !!getKey(), keyFromEnv: !!process.env.MUAPI_KEY });
    if (method === 'POST') {
      const body = await readJson(req);
      settings.muapiKey = String(body.muapiKey || '').trim();
      await fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings), { mode: 0o600 });
      return ok(res, { hasKey: !!getKey() });
    }
  }

  if (resource === 'models' && method === 'GET') return ok(res, MODELS);

  if (resource === 'media') {
    if (method === 'GET' && !id) {
      const q = url.searchParams.get('q') || '';
      const kind = url.searchParams.get('kind') || '';
      let items = library.linearSearch(q); // Exp 2
      if (kind) items = items.filter((x) => x.kind === kind);
      const sorter = SORTS[url.searchParams.get('sort')] || SORTS.newest;
      return ok(res, sorter(items));
    }
    if (method === 'POST' && !id) {
      const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      const kind = kindOf(mime);
      if (!kind) return fail(res, 415, 'Only video, image and audio files are supported');
      const len = Number(req.headers['content-length'] || 0);
      if (len > MAX_UPLOAD) return fail(res, 413, 'File too large (max 1 GB)');
      const name = safeName(decodeURIComponent(String(req.headers['x-filename'] || 'upload')));
      const mid = uid('m');
      const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [EXT_FOR[mime] || ''])[0];
      const file = mid + ext;
      const dest = path.join(MEDIA_DIR, file);
      let size = 0;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); reject(Object.assign(new Error('File too large'), { status: 413 })); } });
        req.pipe(out);
        out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
      }).catch(async (e) => { await fsp.rm(dest, { force: true }); throw e; });
      const item = addMediaItem({
        id: mid, file, mime, size, kind, name: name.replace(/\.[^.]+$/, ''), source: 'upload',
        duration: Number(req.headers['x-duration']) || 0, width: Number(req.headers['x-width']) || 0,
        height: Number(req.headers['x-height']) || 0, createdAt: Date.now(),
      });
      return send(res, 201, item);
    }
    if (id && method === 'PATCH') {
      const item = library.get(id);
      if (!item) return fail(res, 404, 'Not found');
      const body = await readJson(req);
      for (const k of ['name', 'duration', 'width', 'height']) if (body[k] !== undefined) item[k] = k === 'name' ? safeName(body[k]) : Number(body[k]) || 0;
      saveLibrary();
      return ok(res, item);
    }
    if (id && method === 'DELETE') {
      const item = library.removeById(id); // Exp 1 delete
      if (!item) return fail(res, 404, 'Not found');
      await fsp.rm(path.join(MEDIA_DIR, item.file), { force: true });
      saveLibrary();
      return ok(res, { deleted: id });
    }
  }

  if (resource === 'generate' && method === 'POST') {
    if (!getKey()) return fail(res, 400, 'Add your MuAPI key in Settings first.');
    const b = await readJson(req);
    const type = ['image', 'video', 'animate'].includes(b.type) ? b.type : null;
    if (!type) return fail(res, 400, 'type must be image, video or animate');
    const prompt = String(b.prompt || '').trim().slice(0, 2000);
    if (!prompt && type !== 'animate') return fail(res, 400, 'Write a prompt first');
    const job = enqueueJob({ type, prompt: prompt || 'Animated image', model: String(b.model || ''), duration: Number(b.duration) || 0, aspect_ratio: String(b.aspect_ratio || '9:16'), sourceId: b.sourceId || null });
    return send(res, 202, job);
  }

  if (resource === 'jobs') {
    if (method === 'GET') return ok(res, [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30));
    if (id && method === 'DELETE') {
      const job = jobs.get(id);
      if (!job) return fail(res, 404, 'Not found');
      if (job.status === 'queued') job.status = 'cancelled';
      if (job.status !== 'running') jobs.delete(id);
      return ok(res, { ok: true });
    }
  }

  if (resource === 'hashtags' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').replace(/^#/, '').toLowerCase();
    const nodes = q ? hashtags.prefix(q) : hashtags.inorder();
    return ok(res, nodes.slice(0, 12).map((n) => '#' + n.key));
  }

  if (resource === 'autoreel' && method === 'POST') {
    const b = await readJson(req);
    let items = (Array.isArray(b.ids) && b.ids.length ? b.ids.map((x) => library.get(x)).filter(Boolean) : library.display())
      .filter((x) => x.kind !== 'audio').slice(0, 30);
    if (!items.length) return fail(res, 400, 'Add some photos or videos first');
    const graph = DS.buildSceneGraph(items);
    const order = b.mode === 'dfs' ? DS.dfs(graph) : DS.bfs(graph);
    return ok(res, { order: order.map((i) => items[i].id), graph });
  }

  if (resource === 'eval' && method === 'GET') {
    const v = DS.evaluate(url.searchParams.get('expr') || '');
    return ok(res, { value: Number.isFinite(v) ? v : null, postfix: DS.infixToPostfix(url.searchParams.get('expr') || '') });
  }

  if (resource === 'projects') {
    if (method === 'GET' && !id) {
      const files = (await fsp.readdir(PROJECT_DIR)).filter((f) => f.endsWith('.json'));
      const list = [];
      for (const f of files) {
        try { const p = JSON.parse(await fsp.readFile(path.join(PROJECT_DIR, f), 'utf8')); list.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, clips: (p.clips || []).length }); }
        catch (e) { /* skip broken */ }
      }
      return ok(res, DS.insertionSort(list, (p) => -(p.updatedAt || 0)));
    }
    if (method === 'POST' && !id) {
      const b = await readJson(req);
      const p = { id: uid('p'), name: safeName(b.name || 'My reel'), clips: [], music: null, aspect: '9:16', caption: '', createdAt: Date.now(), updatedAt: Date.now() };
      await fsp.writeFile(path.join(PROJECT_DIR, p.id + '.json'), JSON.stringify(p));
      return send(res, 201, p);
    }
    if (id && !/^p_[a-f0-9]{12}$/.test(id)) return fail(res, 400, 'Bad project id');
    const pfile = id && path.join(PROJECT_DIR, id + '.json');
    if (id && method === 'GET') {
      try { return ok(res, JSON.parse(await fsp.readFile(pfile, 'utf8'))); } catch (e) { return fail(res, 404, 'Project not found'); }
    }
    if (id && method === 'PUT') {
      const b = await readJson(req, 5 * 1024 * 1024);
      // round-trip through the Exp 4 timeline so the stored order is a clean chain
      const tl = new DS.Timeline(); tl.fromArray(Array.isArray(b.clips) ? b.clips : []);
      const p = { ...b, id, name: safeName(b.name), clips: tl.display(), updatedAt: Date.now() };
      await fsp.writeFile(pfile, JSON.stringify(p));
      return ok(res, { id, updatedAt: p.updatedAt });
    }
    if (id && method === 'DELETE') { await fsp.rm(pfile, { force: true }); return ok(res, { deleted: id }); }
  }

  return fail(res, 404, 'Unknown API route');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/media/')) {
      const p = insideDir(MEDIA_DIR, decodeURIComponent(url.pathname.slice(7)));
      return p ? serveFile(req, res, p, { immutable: true }) : fail(res, 400, 'Bad path');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
    const p = insideDir(PUBLIC_DIR, rel);
    return p ? serveFile(req, res, p) : fail(res, 400, 'Bad path');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.message || 'Server error');
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  🎬 Reel Maker Studio running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    console.log(`  Media & projects stored in ${DATA_DIR}`);
    console.log(getKey() ? '  MuAPI key: configured\n' : '  MuAPI key: not set (AI generation disabled until you add one in Settings)\n');
  });
}

module.exports = { server };
