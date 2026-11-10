/*
 * muapi.js — server-side AI generation client.
 *
 * Adapted from the open-generative-ai repository (src/lib/muapi.js and
 * packages/studio/src/utils/generationLifecycle.js): same submit -> poll flow
 * against api.muapi.ai, same `x-api-key` header, same result normalisation.
 * Runs on the backend so the API key never reaches the browser, and so
 * generated files can be downloaded into the local media library (no CORS,
 * no tainted canvas when exporting).
 *
 * The model list is a curated subset of packages/studio/src/models.js
 * (t2iModels / t2vModels / i2vModels) that suits vertical reels.
 */
'use strict';

const BASE_URL = process.env.MUAPI_BASE_URL || 'https://api.muapi.ai';

const MODELS = {
  image: [
    { id: 'nano-banana-2', name: 'Nano Banana 2', endpoint: 'nano-banana-2' },
    { id: 'nano-banana-pro', name: 'Nano Banana Pro', endpoint: 'nano-banana-pro' },
    { id: 'seedream-5.0', name: 'Seedream 5.0', endpoint: 'seedream-5.0' },
    { id: 'flux-schnell', name: 'FLUX.1 Schnell (fast)', endpoint: 'flux-schnell-image' },
    { id: 'flux-dev', name: 'FLUX.1 Dev', endpoint: 'flux-dev-image' },
    { id: 'gpt-image-2', name: 'GPT Image 2', endpoint: 'gpt-image-2-text-to-image' },
  ],
  video: [
    { id: 'seedance-pro-t2v-fast', name: 'Seedance Pro Fast', endpoint: 'seedance-pro-t2v-fast', durations: [5, 10] },
    { id: 'seedance-v2.0-t2v', name: 'Seedance 2.0', endpoint: 'seedance-v2.0-t2v', durations: [5, 10] },
    { id: 'kling-v2.6-pro-t2v', name: 'Kling 2.6 Pro', endpoint: 'kling-v2.6-pro-t2v', durations: [5, 10] },
    { id: 'veo3.1-fast-text-to-video', name: 'Veo 3.1 Fast', endpoint: 'veo3.1-fast-text-to-video', durations: [8] },
    { id: 'wan2.5-text-to-video-fast', name: 'Wan 2.5 Fast', endpoint: 'wan2.5-text-to-video-fast', durations: [5, 10] },
  ],
  animate: [
    { id: 'seedance-pro-i2v', name: 'Seedance Pro', endpoint: 'seedance-pro-i2v', durations: [5, 10] },
    { id: 'kling-v2.1-standard-i2v', name: 'Kling 2.1 Standard', endpoint: 'kling-v2.1-standard-i2v', durations: [5, 10] },
    { id: 'veo3-fast-image-to-video', name: 'Veo 3 Fast', endpoint: 'veo3-fast-image-to-video', durations: [8] },
    { id: 'wan2.2-image-to-video', name: 'Wan 2.2', endpoint: 'wan2.2-image-to-video', durations: [5] },
  ],
};

const SUCCESS = new Set(['completed', 'succeeded', 'success']);
const FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function findModel(type, id) {
  const list = MODELS[type] || [];
  return list.find((m) => m.id === id) || list[0];
}

function normalise(r) {
  const url = (r.outputs && r.outputs[0]) || r.url || (r.output && r.output.url);
  return { ...r, url };
}

class MuapiClient {
  constructor(getKey) { this.getKey = getKey; }

  headers(json = true) {
    const key = this.getKey();
    if (!key) throw new Error('No MuAPI key set. Open Settings and paste your key (or set MUAPI_KEY).');
    return json ? { 'Content-Type': 'application/json', 'x-api-key': key } : { 'x-api-key': key };
  }

  async submit(endpoint, payload, onStatus, maxAttempts = 600) {
    onStatus('Submitting');
    const res = await fetch(`${BASE_URL}/api/v1/${endpoint}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`MuAPI request failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const requestId = data.request_id || data.id;
    if (!requestId) return normalise(data);
    return normalise(await this.poll(requestId, onStatus, maxAttempts));
  }

  async poll(requestId, onStatus, maxAttempts, interval = 2000) {
    const url = `${BASE_URL}/api/v1/predictions/${requestId}/result`;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await wait(interval);
      let res;
      try { res = await fetch(url, { headers: this.headers() }); }
      catch (e) { if (attempt === maxAttempts) throw e; continue; }
      if (!res.ok) {
        if (res.status >= 500 && attempt < maxAttempts) continue;
        throw new Error(`MuAPI poll failed (${res.status}): ${(await res.text()).slice(0, 120)}`);
      }
      let r;
      try { r = await res.json(); } catch (e) { continue; }
      const st = String(r.status || '').toLowerCase();
      if (st) onStatus(st.charAt(0).toUpperCase() + st.slice(1));
      if (SUCCESS.has(st)) return r;
      if (FAILURE.has(st)) {
        const msg = (r.error && (r.error.message || r.error)) || r.message || 'Unknown error';
        throw new Error(`Generation failed: ${msg}`);
      }
    }
    throw new Error(`Timed out waiting for MuAPI. Request ID: ${requestId}`);
  }

  generateImage({ model, prompt, aspect_ratio = '9:16' }, onStatus) {
    const m = findModel('image', model);
    return this.submit(m.endpoint, { prompt, aspect_ratio, image_url: null }, onStatus, 120);
  }

  generateVideo({ model, prompt, aspect_ratio = '9:16', duration }, onStatus) {
    const m = findModel('video', model);
    const p = { prompt, aspect_ratio };
    if (duration) p.duration = Number(duration);
    return this.submit(m.endpoint, p, onStatus);
  }

  animateImage({ model, prompt, image_url, aspect_ratio = '9:16', duration }, onStatus) {
    const m = findModel('animate', model);
    const p = { prompt: prompt || 'subtle cinematic motion', image_url, aspect_ratio };
    if (duration) p.duration = Number(duration);
    return this.submit(m.endpoint, p, onStatus);
  }

  // Upload a local file so image->video models can read it from a public URL.
  async uploadBuffer(buffer, filename, mime) {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), filename);
    const res = await fetch(`${BASE_URL}/api/v1/upload_file`, { method: 'POST', headers: this.headers(false), body: fd });
    if (!res.ok) throw new Error(`MuAPI upload failed (${res.status})`);
    const d = await res.json();
    const url = d.url || d.file_url || (d.data && d.data.url);
    if (!url) throw new Error('MuAPI upload returned no URL');
    return url;
  }
}

module.exports = { MuapiClient, MODELS, findModel };
