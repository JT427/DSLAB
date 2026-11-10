/* api.js — thin client for the Reel Studio backend (server/server.js). */
(function (global) {
  'use strict';

  async function req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  // Read duration / size from a local file before uploading it
  function probe(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
      if (file.type.startsWith('image/')) {
        const img = new Image();
        img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
        img.onerror = () => done({});
        img.src = url;
      } else {
        const el = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video');
        el.preload = 'metadata';
        el.onloadedmetadata = () => done({ duration: el.duration || 0, width: el.videoWidth || 0, height: el.videoHeight || 0 });
        el.onerror = () => done({});
        el.src = url;
        setTimeout(() => done({}), 8000);
      }
    });
  }

  async function upload(file, onProgress) {
    const meta = await probe(file);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media');
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      if (meta.duration) xhr.setRequestHeader('X-Duration', String(meta.duration));
      if (meta.width) xhr.setRequestHeader('X-Width', String(meta.width));
      if (meta.height) xhr.setRequestHeader('X-Height', String(meta.height));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { /* */ }
        xhr.status < 300 ? resolve(d) : reject(new Error((d && d.error) || 'Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Network error while uploading'));
      xhr.send(file);
    });
  }

  global.API = {
    health: () => req('GET', '/api/health'),
    settings: () => req('GET', '/api/settings'),
    saveKey: (muapiKey) => req('POST', '/api/settings', { muapiKey }),
    models: () => req('GET', '/api/models'),
    media: (q = '', sort = 'newest', kind = '') => req('GET', `/api/media?q=${encodeURIComponent(q)}&sort=${sort}&kind=${kind}`),
    patchMedia: (id, body) => req('PATCH', `/api/media/${id}`, body),
    deleteMedia: (id) => req('DELETE', `/api/media/${id}`),
    upload,
    generate: (body) => req('POST', '/api/generate', body),
    jobs: () => req('GET', '/api/jobs'),
    cancelJob: (id) => req('DELETE', `/api/jobs/${id}`),
    hashtags: (q) => req('GET', `/api/hashtags?q=${encodeURIComponent(q || '')}`),
    autoreel: (mode, ids) => req('POST', '/api/autoreel', { mode, ids }),
    projects: () => req('GET', '/api/projects'),
    project: (id) => req('GET', `/api/projects/${id}`),
    createProject: (name) => req('POST', '/api/projects', { name }),
    saveProject: (p) => req('PUT', `/api/projects/${p.id}`, p),
    deleteProject: (id) => req('DELETE', `/api/projects/${id}`),
  };
})(window);
