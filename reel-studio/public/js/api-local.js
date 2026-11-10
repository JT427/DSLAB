/*
 * api-local.js — browser-only stand-in for the backend, used by the demo build
 * (scripts/build-demo.js). It exposes the same window.API as api.js, but keeps
 * everything in memory and runs the DSLAB data structures (ds.js) in the page
 * instead of on the server. Nothing is saved between visits and AI generation
 * is off, because both need the real backend.
 */
(function (global) {
  'use strict';

  const library = new DS.MediaLibrary(); // Exp 1
  const projects = new Map();
  const hashtags = new DS.BST(); // Exp 11
  ['reels', 'reelsinstagram', 'reelitfeelit', 'explore', 'explorepage', 'viral', 'trending', 'fyp', 'foryou', 'instagood',
    'photooftheday', 'travel', 'travelgram', 'wanderlust', 'food', 'foodie', 'fitness', 'gym', 'workout',
    'fashion', 'style', 'ootd', 'beauty', 'makeup', 'music', 'dance', 'art', 'artist', 'design', 'nature', 'sunset',
    'beach', 'summer', 'love', 'happy', 'friends', 'family', 'motivation', 'inspiration', 'tech', 'coding', 'developer',
    'ai', 'aiart', 'generativeai', 'startup', 'business', 'marketing', 'smallbusiness', 'tutorial', 'howto', 'diy',
    'comedy', 'funny', 'memes', 'pets', 'dog', 'cat', 'gaming', 'cinematic', 'vlog', 'dayinmylife', 'tbt', 'weekend',
    'coffee', 'recipe', 'healthy', 'yoga', 'photography', 'film', 'behindthescenes', 'newpost', 'trend', 'transition',
  ].forEach((t) => hashtags.insert(t));

  const SORTS = { // Exp 8, 9, 10, 12
    newest: (a) => DS.insertionSort(a, (x) => -(x.createdAt || 0)),
    duration: (a) => DS.quickSort(a, (x) => x.duration || 0),
    name: (a) => DS.mergeSort(a, (x) => x.name.toLowerCase()),
    size: (a) => DS.heapSort(a, (x) => -(x.size || 0)),
  };
  const uid = (p) => p + '_' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  const kindOf = (mime) => (mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : null);

  function probe(file, url) {
    return new Promise((resolve) => {
      if (file.type.startsWith('image/')) {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
        img.onerror = () => resolve({});
        img.src = url;
      } else {
        const el = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video');
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve({ duration: el.duration || 0, width: el.videoWidth || 0, height: el.videoHeight || 0 });
        el.onerror = () => resolve({});
        el.src = url;
        setTimeout(() => resolve({}), 8000);
      }
    });
  }

  async function upload(file, onProgress) {
    const kind = kindOf(file.type || '');
    if (!kind) throw new Error('Only video, photo and audio files are supported');
    const url = URL.createObjectURL(file);
    const meta = await probe(file, url);
    onProgress && onProgress(1);
    const item = {
      id: uid('m'), url, mime: file.type, size: file.size, kind, name: file.name.replace(/\.[^.]+$/, ''), source: 'upload',
      duration: meta.duration || 0, width: meta.width || 0, height: meta.height || 0, createdAt: Date.now(),
    };
    library.insert(0, item);
    return item;
  }

  const noAI = () => Promise.reject(new Error('AI generation needs the full app with its backend'));

  global.API = {
    health: async () => ({ ok: true, items: library.n, hasKey: false }),
    settings: async () => ({ hasKey: false, keyFromEnv: false }),
    saveKey: noAI,
    models: async () => ({
      image: [{ id: 'nano-banana-2', name: 'Nano Banana 2' }, { id: 'seedream-5.0', name: 'Seedream 5.0' }],
      video: [{ id: 'seedance-v2.0-t2v', name: 'Seedance 2.0', durations: [5, 10] }, { id: 'kling-v2.6-pro-t2v', name: 'Kling 2.6 Pro', durations: [5, 10] }],
      animate: [{ id: 'seedance-pro-i2v', name: 'Seedance Pro', durations: [5, 10] }],
    }),
    media: async (q = '', sort = 'newest', kind = '') => {
      let items = library.linearSearch(q); // Exp 2
      if (kind) items = items.filter((x) => x.kind === kind);
      return (SORTS[sort] || SORTS.newest)(items);
    },
    patchMedia: async (id, body) => Object.assign(library.get(id) || {}, body),
    deleteMedia: async (id) => { const it = library.removeById(id); if (it && it.url) URL.revokeObjectURL(it.url); return { deleted: id }; },
    upload,
    generate: noAI,
    jobs: async () => [],
    cancelJob: async () => ({ ok: true }),
    hashtags: async (q) => {
      q = (q || '').replace(/^#/, '').toLowerCase();
      return (q ? hashtags.prefix(q) : hashtags.inorder()).slice(0, 12).map((n) => '#' + n.key);
    },
    autoreel: async (mode) => {
      const items = library.display().filter((x) => x.kind !== 'audio').slice(0, 30);
      if (!items.length) throw new Error('Add some photos or videos first');
      const graph = DS.buildSceneGraph(items); // Exp 13
      const order = mode === 'dfs' ? DS.dfs(graph) : DS.bfs(graph);
      return { order: order.map((i) => items[i].id), graph };
    },
    projects: async () => DS.insertionSort([...projects.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, clips: (p.clips || []).length })), (p) => -(p.updatedAt || 0)),
    project: async (id) => { const p = projects.get(id); if (!p) throw new Error('Project not found'); return JSON.parse(JSON.stringify(p)); },
    createProject: async (name) => {
      const p = { id: uid('p'), name: name || 'My reel', clips: [], music: null, aspect: '9:16', caption: '', createdAt: Date.now(), updatedAt: Date.now() };
      projects.set(p.id, p);
      return p;
    },
    saveProject: async (p) => { projects.set(p.id, { ...JSON.parse(JSON.stringify(p)), updatedAt: Date.now() }); return { id: p.id }; },
    deleteProject: async (id) => { projects.delete(id); return { deleted: id }; },
  };
})(window);
