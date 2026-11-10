/*
 * app.js — Reel Maker Studio UI.
 *
 * State lives in a doubly linked list timeline (DSLAB Exp 4) and every edit
 * pushes a snapshot onto the undo stack (Exp 5). Projects, media and AI jobs
 * are persisted by the backend (server/server.js).
 */
(function () {
  'use strict';

  const { Engine, FILTERS, TRANSITIONS, MOTIONS, TEXT_STYLES, TEXT_ANIMS, BACKGROUNDS } = window.ReelEngine;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ------------------------------------------------------------- helpers */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  const icon = (id, cls = 'ic') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + id); s.append(u); return s; };
  const uid = () => 'c' + Math.random().toString(36).slice(2, 10);
  const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
  const fmtS = (t) => (Math.round((t || 0) * 10) / 10).toFixed(1) + 's';
  const fmtBytes = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  const gradCss = (key) => { const s = BACKGROUNDS[key] || BACKGROUNDS.sunset; return `linear-gradient(135deg, ${s.join(', ')})`; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const safeLS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } } };

  function toast(msg, type = 'ok', action) {
    const t = h('div', { class: 'toast ' + type }, type === 'ok' ? icon('check') : null, h('span', null, msg));
    if (action) { const b = h('button', { class: 'btn sm', style: { pointerEvents: 'auto', marginLeft: '6px' }, onclick: () => { action.fn(); t.remove(); } }, action.label); t.append(b); }
    $('#toasts').append(t);
    setTimeout(() => t.remove(), action ? 6000 : 3200);
  }

  /* -------------------------------------------------------------- state */
  const S = {
    project: null,
    timeline: new DS.Timeline(), // Exp 4
    history: new DS.History(80), // Exp 5
    selectedId: null,
    library: [],
    models: { image: [], video: [], animate: [] },
    hasKey: false,
    aiType: 'image',
    pps: 70,
    exported: false,
    libQuery: '', libSort: 'newest', libKind: '',
  };
  const engine = new Engine($('#canvas'));
  window.studio = { S, engine }; // handy for debugging

  /* ----------------------------------------------------------- projects */
  function snapshot() {
    return JSON.stringify({ clips: S.timeline.display(), music: S.project.music, aspect: S.project.aspect, caption: S.project.caption });
  }
  function restore(snap) {
    const d = JSON.parse(snap);
    S.timeline.fromArray(d.clips);
    Object.assign(S.project, { music: d.music, aspect: d.aspect, caption: d.caption });
    if (S.selectedId && !S.timeline.searching(S.selectedId)) S.selectedId = null;
    refresh();
  }
  // Every structural edit goes through commit() so it can be undone
  function commit(fn, opts = {}) {
    S.history.record(snapshot());
    fn();
    refresh(opts);
  }
  // For sliders: record once when the drag starts, then update live
  let liveArmed = false;
  function live(fn) {
    if (!liveArmed) { S.history.record(snapshot()); liveArmed = true; }
    fn();
    refresh({ inspector: false });
  }
  document.addEventListener('change', () => { liveArmed = false; }, true);
  document.addEventListener('pointerup', () => { liveArmed = false; }, true);

  function undo() { const s = S.history.undo(snapshot()); if (s) restore(s); }
  function redo() { const s = S.history.redo(snapshot()); if (s) restore(s); }

  function refresh({ inspector = true } = {}) {
    S.project.clips = S.timeline.display();
    engine.setProject(S.project);
    renderTimeline();
    if (inspector) renderInspector();
    renderMusic();
    updateChrome();
    scheduleSave();
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    const st = $('#saveState'); st.textContent = 'Saving…'; st.className = 'save-state saving';
    saveTimer = setTimeout(async () => {
      try {
        S.project.name = $('#projectName').value.trim() || 'My reel';
        S.project.clips = S.timeline.display();
        await API.saveProject(S.project);
        st.textContent = 'Saved'; st.className = 'save-state';
      } catch (e) { st.textContent = 'Not saved'; st.className = 'save-state error'; st.title = e.message; }
    }, 700);
  }

  async function openProject(id) {
    const p = await API.project(id);
    S.project = { aspect: '9:16', music: null, caption: '', ...p };
    S.timeline.fromArray(p.clips || []);
    S.history = new DS.History(80);
    S.selectedId = null; S.exported = false;
    $('#projectName').value = S.project.name;
    safeLS.set('reel_project', id);
    engine.seek(0);
    refresh();
  }
  async function newProject() {
    const p = await API.createProject('My reel');
    await openProject(p.id);
  }

  /* ------------------------------------------------------- clip factory */
  function clipFromMedia(m) {
    const isVideo = m.kind === 'video';
    const dur = isVideo ? Math.min(m.duration || 5, 10) : 3;
    return {
      id: uid(), kind: m.kind, mediaId: m.id, src: '/media/' + m.file, name: m.name,
      duration: Math.round(dur * 10) / 10, trimIn: 0, mediaDuration: isVideo ? m.duration || 0 : 0,
      volume: 1, muted: false, filter: 'none', transition: 'fade', motion: isVideo ? 'none' : 'zoomIn', fit: 'cover', text: null,
    };
  }
  const TITLE_TEMPLATES = [
    { text: 'Wait for it…', style: 'bold', bg: 'sunset', anim: 'pop' },
    { text: 'POV:\nyou finally did it', style: 'box', bg: 'ocean', anim: 'slideUp', color: '#ffffff' },
    { text: 'DAY IN MY LIFE', style: 'outline', bg: 'night', anim: 'fade', color: '#fde047' },
    { text: 'Thank you!', style: 'script', bg: 'candy', anim: 'fade' },
    { text: 'NEW DROP', style: 'neon', bg: 'mono', anim: 'pop', color: '#22d3ee' },
    { text: '3 tips you need', style: 'bold', bg: 'mint', anim: 'typewriter' },
  ];
  function titleClip(t) {
    return {
      id: uid(), kind: 'title', name: t.text.replace(/\n/g, ' '), duration: 2.5, bg: t.bg, filter: 'none', transition: 'fade',
      text: { content: t.text, style: t.style, position: 'center', anim: t.anim, color: t.color || '#ffffff', size: 76 },
    };
  }

  function selected() { const n = S.selectedId && S.timeline.searching(S.selectedId); return n ? n.info : null; }
  function select(id) { S.selectedId = id; renderTimeline(); renderInspector(); updateTextTab(); }

  // insert after the clip under the playhead (or at the end)
  function addClips(clips, { atPlayhead = false } = {}) {
    if (!clips.length) return;
    commit(() => {
      let after = null;
      if (atPlayhead && S.timeline.size) { const i = engine.indexAt(engine.t); after = S.timeline.searching(S.project.clips[i].id); }
      for (const c of clips) after = after ? S.timeline.insertAfter(after, c) : S.timeline.insertEnd(c);
      S.selectedId = clips[clips.length - 1].id;
    });
  }

  function splitAtPlayhead() {
    if (!S.timeline.size) return;
    const i = engine.indexAt(engine.t);
    const c = S.project.clips[i];
    const local = engine.t - engine.starts[i];
    if (local < 0.2 || c.duration - local < 0.2) return toast('Move the playhead inside a clip to split it', 'error');
    commit(() => {
      const node = S.timeline.searching(c.id);
      const b = clone(c); b.id = uid(); b.duration = +(c.duration - local).toFixed(2); b.transition = 'cut';
      if (c.kind === 'video') b.trimIn = +((c.trimIn || 0) + local).toFixed(2);
      if (b.text) b.text = { ...b.text, anim: 'none' };
      node.info.duration = +local.toFixed(2);
      S.timeline.insertAfter(node, b);
      S.selectedId = b.id;
    });
  }
  function duplicateSelected() {
    const c = selected(); if (!c) return toast('Select a clip first', 'error');
    commit(() => { const b = clone(c); b.id = uid(); S.timeline.insertAfter(S.timeline.searching(c.id), b); S.selectedId = b.id; });
  }
  function deleteSelected() {
    const c = selected(); if (!c) return toast('Select a clip first', 'error');
    const nxt = S.timeline.searching(c.id).next || S.timeline.searching(c.id).prev;
    commit(() => { S.timeline.deletion(c.id); S.selectedId = nxt ? nxt.info.id : null; });
  }

  /* -------------------------------------------------------- thumbnails */
  const thumbs = new Map();
  function thumbFor(c) {
    if (c.kind === 'image') return Promise.resolve(c.src);
    if (c.kind !== 'video') return Promise.resolve(null);
    const key = c.src + '@' + Math.round((c.trimIn || 0) * 2) / 2;
    if (thumbs.has(key)) return thumbs.get(key);
    const p = new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = c.src;
      const fail = setTimeout(() => resolve(null), 8000);
      v.addEventListener('loadeddata', () => { v.currentTime = Math.min((c.trimIn || 0) + 0.15, Math.max(0, (v.duration || 1) - 0.1)); }, { once: true });
      v.addEventListener('seeked', () => {
        try {
          const cv = document.createElement('canvas'); const w = 180; cv.width = w; cv.height = Math.round(w * (v.videoHeight / v.videoWidth || 1.77));
          cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
          clearTimeout(fail); resolve(cv.toDataURL('image/jpeg', 0.72));
        } catch (e) { resolve(null); }
        v.removeAttribute('src'); v.load();
      }, { once: true });
      v.addEventListener('error', () => resolve(null), { once: true });
    });
    thumbs.set(key, p);
    return p;
  }

  /* ------------------------------------------------------------ library */
  async function loadLibrary() {
    try { S.library = await API.media(S.libQuery, S.libSort, S.libKind); }
    catch (e) { toast(e.message, 'error'); S.library = []; }
    renderLibrary(); renderAudioList(); renderAnimateSources();
  }

  function renderLibrary() {
    const root = $('#library'); root.innerHTML = '';
    const items = S.library.filter((m) => m.kind !== 'audio');
    if (!items.length) {
      root.append(h('div', { class: 'lib-empty' }, S.libQuery ? 'Nothing matches your search.' : 'Your uploads and AI creations will show up here.'));
      return;
    }
    for (const m of items) {
      const src = '/media/' + m.file;
      const media = m.kind === 'video' ? h('video', { src: src + '#t=0.4', preload: 'metadata', muted: true, playsinline: true }) : h('img', { src, loading: 'lazy', alt: '' });
      if (m.kind === 'video') media.muted = true;
      const card = h('div', { class: 'card', draggable: 'true', title: m.name },
        media,
        h('span', { class: 'badge' + (m.source === 'ai' ? ' ai' : '') }, m.source === 'ai' ? 'AI' : m.kind === 'video' ? 'VIDEO' : 'PHOTO'),
        h('button', { class: 'add', title: 'Add to reel', onclick: (e) => { e.stopPropagation(); addClips([clipFromMedia(m)]); toast('Added to your reel'); } }, icon('plus')),
        h('button', { class: 'icon-btn sm del', title: 'Delete from library', onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete "${m.name}" from your library?`)) return;
          try { await API.deleteMedia(m.id); loadLibrary(); } catch (err) { toast(err.message, 'error'); }
        } }, icon('trash')),
        h('div', { class: 'meta' }, h('span', null, m.name), h('span', null, m.kind === 'video' ? fmtS(m.duration) : '')),
      );
      card.addEventListener('dblclick', () => { addClips([clipFromMedia(m)]); toast('Added to your reel'); });
      card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/media-id', m.id); e.dataTransfer.effectAllowed = 'copy'; });
      if (m.kind === 'video') { card.addEventListener('mouseenter', () => media.play().catch(() => {})); card.addEventListener('mouseleave', () => { media.pause(); }); }
      root.append(card);
    }
  }

  async function uploadFiles(files, { useAsMusic = false } = {}) {
    const list = Array.from(files).filter((f) => /^(video|image|audio)\//.test(f.type));
    if (!list.length) return toast('Choose video, photo or audio files', 'error');
    const box = $('#uploads');
    const added = [];
    for (const f of list) {
      const bar = h('i'); const row = h('div', { class: 'upload-row' }, 'Uploading ' + f.name, h('div', { class: 'bar' }, bar));
      box.append(row);
      try {
        const item = await API.upload(f, (p) => { bar.style.width = Math.round(p * 100) + '%'; });
        added.push(item);
      } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
      row.remove();
    }
    await loadLibrary();
    const visual = added.filter((m) => m.kind !== 'audio');
    const audio = added.filter((m) => m.kind === 'audio');
    if (visual.length) {
      addClips(visual.map(clipFromMedia));
      toast(`${visual.length} ${visual.length === 1 ? 'clip' : 'clips'} added to your reel`);
    }
    if (audio.length && (useAsMusic || !S.project.music)) setMusic(audio[0]);
  }

  /* ---------------------------------------------------------- timeline */
  function renderTimeline() {
    const track = $('#track'); track.innerHTML = '';
    const clips = S.project.clips;
    const pps = S.pps;
    const total = engine.total;
    const width = Math.max(total * pps, $('#timeline').clientWidth - 40);
    $('#ruler').style.width = width + 'px';
    track.style.width = width + 'px';
    $('#musicTrack').style.width = width + 'px';
    // ruler
    const ruler = $('#ruler'); ruler.innerHTML = '';
    const step = pps >= 90 ? 0.5 : 1; const major = pps >= 60 ? 5 : 10;
    for (let s = 0; s * pps <= width; s += step) {
      const isMajor = Math.abs(s % major) < 1e-6 || s === 0;
      ruler.append(h('div', { class: 'tick' + (isMajor ? ' major' : ''), style: { left: s * pps + 'px' } }, isMajor ? h('span', null, fmt(s)) : null));
    }
    if (!clips.length) {
      track.append(h('div', { class: 'track-empty' }, 'Your reel is empty — add media from the left, or drop it here'));
    }
    clips.forEach((c, i) => {
      const w = Math.max(6, c.duration * pps);
      const strip = h('div', { class: 'strip' });
      if (c.kind === 'title') strip.append(h('div', { class: 'title-bg', style: { background: gradCss(c.bg) } }, c.text ? c.text.content : ''));
      else thumbFor(c).then((src) => { if (src) { const img = h('img', { src, alt: '' }); strip.style.background = `url("${src}") repeat-x left / auto 100%`; strip.append(img); img.style.opacity = 0; } });
      const tags = h('div', { class: 'tag' });
      if (c.text && c.text.content && c.kind !== 'title') tags.append(h('i', null, 'T'));
      if (c.filter && c.filter !== 'none') tags.append(h('i', null, '✦'));
      if (c.kind === 'video' && c.muted) tags.append(h('i', null, '🔇'));
      const el = h('div', {
        class: 'clip' + (c.id === S.selectedId ? ' selected' : ''), draggable: 'true', 'data-id': c.id,
        style: { width: w + 'px' }, title: `${c.name} · ${fmtS(c.duration)}`,
      },
      strip, tags,
      w > 46 ? h('div', { class: 'label' }, h('span', null, c.name), h('span', null, fmtS(c.duration))) : null,
      i > 0 && c.transition && c.transition !== 'cut' ? h('div', { class: 'tr-dot', title: 'Transition: ' + TRANSITIONS[c.transition] }, '◆') : null,
      h('div', { class: 'handle', title: 'Drag to change length' }));
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('handle')) return;
        select(c.id);
        const rect = el.getBoundingClientRect();
        engine.seek(engine.starts[i] + clamp((e.clientX - rect.left) / pps, 0, c.duration - 0.01));
      });
      // reorder (drag & drop)
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/clip-id', c.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      // resize
      const handle = el.querySelector('.handle');
      handle.addEventListener('pointerdown', (e) => startResize(e, c, el));
      track.append(el);
    });
    renderMusicTrack();
    positionPlayhead();
    const n = clips.length;
    $('#tlInfo').textContent = `${n} ${n === 1 ? 'clip' : 'clips'} · ${fmt(total)}`;
  }

  function startResize(e, c, el) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startDur = c.duration;
    const max = c.kind === 'video' && c.mediaDuration ? c.mediaDuration - (c.trimIn || 0) : 60;
    S.history.record(snapshot());
    const node = S.timeline.searching(c.id);
    const move = (ev) => {
      const d = clamp(startDur + (ev.clientX - startX) / S.pps, 0.3, max);
      node.info.duration = Math.round(d * 10) / 10;
      el.style.width = node.info.duration * S.pps + 'px';
      const lbl = el.querySelector('.label span:last-child'); if (lbl) lbl.textContent = fmtS(node.info.duration);
      S.project.clips = S.timeline.display(); engine.setProject(S.project);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); S.selectedId = c.id; refresh(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  function dropIndex(clientX) {
    const els = $$('#track .clip');
    for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (clientX < r.left + r.width / 2) return i; }
    return els.length;
  }
  function setupTrackDnD() {
    const track = $('#track');
    track.addEventListener('dragover', (e) => {
      e.preventDefault();
      track.classList.add('drop-target');
      $$('#track .clip').forEach((x) => x.classList.remove('drop-before'));
      const i = dropIndex(e.clientX); const els = $$('#track .clip');
      if (els[i]) els[i].classList.add('drop-before');
    });
    track.addEventListener('dragleave', (e) => { if (!track.contains(e.relatedTarget)) { track.classList.remove('drop-target'); $$('#track .clip').forEach((x) => x.classList.remove('drop-before')); } });
    track.addEventListener('drop', (e) => {
      e.preventDefault();
      track.classList.remove('drop-target');
      $$('#track .clip').forEach((x) => x.classList.remove('drop-before'));
      const to = dropIndex(e.clientX);
      const clipId = e.dataTransfer.getData('text/clip-id');
      const mediaId = e.dataTransfer.getData('text/media-id');
      if (clipId) {
        const from = S.timeline.indexOf(clipId);
        const target = to > from ? to - 1 : to;
        if (target !== from) commit(() => { S.timeline.moveTo(clipId, target); S.selectedId = clipId; });
      } else if (mediaId) {
        const m = S.library.find((x) => x.id === mediaId); if (!m) return;
        const c = clipFromMedia(m);
        commit(() => { S.timeline.insertEnd(c); S.timeline.moveTo(c.id, to); S.selectedId = c.id; });
      } else if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });
  }

  function positionPlayhead() {
    const x = engine.t * S.pps;
    $('#playhead').style.left = 14 + x + 'px';
  }
  function setupScrub() {
    const tl = $('#timeline');
    const scrub = (e) => {
      const r = $('#ruler').getBoundingClientRect();
      engine.seek(clamp((e.clientX - r.left) / S.pps, 0, engine.total));
    };
    $('#ruler').addEventListener('pointerdown', (e) => {
      scrub(e);
      const mv = (ev) => scrub(ev);
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    tl.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(S.pps * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
  }
  function setZoom(v) { S.pps = clamp(Math.round(v), 30, 160); $('#tlZoom').value = S.pps; safeLS.set('reel_zoom', S.pps); renderTimeline(); }

  function renderMusicTrack() {
    const mt = $('#musicTrack'); mt.innerHTML = '';
    const m = S.project.music;
    if (!m) return;
    mt.append(h('div', { class: 'bar', style: { width: Math.max(80, engine.total * S.pps) + 'px' } }, icon('music'), m.name));
  }

  /* ----------------------------------------------------------- inspector */
  function group(title, ...kids) { return h('div', { class: 'group' }, h('h4', null, ...[].concat(title)), ...kids); }
  function pills(options, value, onPick, cols) {
    const wrap = h('div', { class: 'pills', style: cols ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : null });
    for (const [k, label] of Object.entries(options)) {
      wrap.append(h('button', { class: 'pill' + (k === value ? ' active' : ''), onclick: () => { $$('.pill', wrap).forEach((p) => p.classList.remove('active')); wrap.children[Object.keys(options).indexOf(k)].classList.add('active'); onPick(k); } }, label));
    }
    return wrap;
  }
  // number field that accepts arithmetic ("2*1.5+.5") via infix->postfix (Exp 6)
  function slider(label, value, { min, max, step = 0.1, unit = 's', onInput }) {
    const range = h('input', { type: 'range', min, max, step, value });
    const num = h('input', { class: 'num-input', value: (+value).toFixed(step < 1 ? 1 : 0) + unit, title: 'Type a number or a sum like 2*1.5' });
    range.addEventListener('input', () => { num.value = (+range.value).toFixed(step < 1 ? 1 : 0) + unit; onInput(+range.value); });
    const applyNum = () => {
      const v = DS.evaluate(num.value.replace(/[a-z%]/gi, ''));
      if (!Number.isFinite(v)) { num.value = (+range.value).toFixed(1) + unit; return toast('Not a number', 'error'); }
      const c = clamp(v, +min, +max); range.value = c; num.value = c.toFixed(step < 1 ? 1 : 0) + unit; liveArmed = false; onInput(c); liveArmed = false;
    };
    num.addEventListener('change', applyNum);
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); });
    return h('div', { class: 'slider' }, h('label', null, label), num, range);
  }
  function toggle(label, on, onChange) {
    const sw = h('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on) });
    sw.addEventListener('click', () => { on = !on; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); onChange(on); });
    return h('div', { class: 'toggle' }, h('span', null, label), sw);
  }
  const COLORS = ['#ffffff', '#111111', '#fde047', '#22d3ee', '#f472b6', '#a78bfa', '#34d399', '#fb923c'];
  function swatches(value, onPick) {
    const w = h('div', { class: 'colors' });
    COLORS.forEach((col) => w.append(h('button', { class: 'swatch' + (col === value ? ' active' : ''), style: { background: col }, title: col, onclick: (e) => { $$('.swatch', w).forEach((s) => s.classList.remove('active')); e.currentTarget.classList.add('active'); onPick(col); } })));
    return w;
  }

  function updateClip(id, patch, isLive) {
    const n = S.timeline.searching(id); if (!n) return;
    const apply = () => { typeof patch === 'function' ? patch(n.info) : Object.assign(n.info, patch); };
    isLive ? live(apply) : commit(apply, { inspector: false });
  }

  function renderInspector() {
    const root = $('#inspector'); root.innerHTML = '';
    const c = selected();
    if (!c) return renderOverview(root);
    const id = c.id;
    const head = h('div', { class: 'insp-head' });
    const th = h('img', { class: 'thumb', alt: '' });
    if (c.kind === 'title') { th.style.background = gradCss(c.bg); th.removeAttribute('src'); }
    else thumbFor(c).then((s) => { if (s) th.src = s; });
    head.append(th, h('div', null, h('h3', null, c.name), h('p', null, (c.kind === 'title' ? 'Title card' : c.kind === 'video' ? 'Video' : 'Photo') + ' · ' + fmtS(c.duration))),
      h('button', { class: 'icon-btn', title: 'Deselect (Esc)', onclick: () => select(null) }, icon('x')));
    root.append(head);

    // Length
    const maxDur = c.kind === 'video' && c.mediaDuration ? Math.max(0.3, c.mediaDuration - (c.trimIn || 0)) : 15;
    const lenGroup = group('Length', slider('Duration', c.duration, { min: 0.3, max: maxDur.toFixed(1), onInput: (v) => updateClip(id, { duration: Math.round(v * 10) / 10 }, true) }));
    if (c.kind === 'video' && c.mediaDuration) {
      lenGroup.append(slider('Start from', c.trimIn || 0, { min: 0, max: Math.max(0, c.mediaDuration - 0.3).toFixed(1), onInput: (v) => updateClip(id, (x) => { x.trimIn = Math.round(v * 10) / 10; x.duration = Math.min(x.duration, +(x.mediaDuration - x.trimIn).toFixed(1)); }, true) }));
    }
    root.append(lenGroup);

    // Look
    const fwrap = h('div', { class: 'filters' });
    for (const [k, f] of Object.entries(FILTERS)) {
      fwrap.append(h('button', { class: 'filter' + ((c.filter || 'none') === k ? ' active' : ''), onclick: (e) => { $$('.filter', fwrap).forEach((x) => x.classList.remove('active')); e.currentTarget.classList.add('active'); updateClip(id, { filter: k }); } },
        h('i', { style: { filter: f.css } }), f.label));
    }
    root.append(group(['Filter', h('button', { class: 'btn ghost sm', onclick: () => applyAll('filter', c.filter || 'none') }, 'Apply to all')], fwrap));

    if (c.kind === 'title') {
      const bgw = h('div', { class: 'colors' });
      for (const k of Object.keys(BACKGROUNDS)) bgw.append(h('button', { class: 'swatch' + (c.bg === k ? ' active' : ''), title: k, style: { background: gradCss(k) }, onclick: (e) => { $$('.swatch', bgw).forEach((s) => s.classList.remove('active')); e.currentTarget.classList.add('active'); updateClip(id, { bg: k }); renderTimeline(); } }));
      root.append(group('Background', bgw));
    } else {
      root.append(group('Framing',
        pills({ cover: 'Fill screen', contain: 'Fit + blur' }, c.fit || 'cover', (v) => updateClip(id, { fit: v }), 2),
        h('div', { style: { height: '8px' } }),
        c.kind === 'image' ? pills(MOTIONS, c.motion || 'none', (v) => updateClip(id, { motion: v })) : null));
    }

    // Transition
    const idx = S.timeline.indexOf(id);
    root.append(group(['Transition in', h('button', { class: 'btn ghost sm', onclick: () => applyAll('transition', c.transition || 'cut') }, 'Apply to all')],
      idx === 0 ? h('p', { class: 'muted small', style: { margin: '0 0 8px' } }, 'First clip — transitions play when entering the next clips.') : null,
      pills(TRANSITIONS, c.transition || 'cut', (v) => { updateClip(id, { transition: v }); renderTimeline(); if (idx > 0) engine.seek(engine.starts[idx] - 0.2); })));

    // Text
    const t = c.text || { content: '', style: 'bold', position: 'bottom', anim: 'fade', color: '#ffffff', size: 64 };
    const ensureText = (x) => { if (!x.text) x.text = { ...t }; return x.text; };
    const ta = h('textarea', { rows: 2, placeholder: 'Add text on this clip…' }); ta.value = t.content;
    ta.addEventListener('input', () => updateClip(id, (x) => { ensureText(x).content = ta.value; if (x.kind === 'title') x.name = ta.value.replace(/\n/g, ' ').slice(0, 40) || 'Title'; }, true));
    ta.addEventListener('blur', () => { liveArmed = false; renderTimeline(); });
    const animSel = h('select');
    for (const [k, l] of Object.entries(TEXT_ANIMS)) animSel.append(h('option', { value: k, selected: k === t.anim }, l));
    animSel.addEventListener('change', () => { updateClip(id, (x) => { ensureText(x).anim = animSel.value; }); engine.seek(engine.starts[idx]); engine.play(); });
    const styleMap = Object.fromEntries(Object.entries(TEXT_STYLES).map(([k, v]) => [k, v.label]));
    root.append(group('Text', ta,
      h('div', { style: { height: '10px' } }),
      pills(styleMap, t.style, (v) => updateClip(id, (x) => { ensureText(x).style = v; })),
      h('div', { style: { height: '8px' } }),
      pills({ top: 'Top', center: 'Middle', bottom: 'Bottom' }, t.position, (v) => updateClip(id, (x) => { ensureText(x).position = v; })),
      h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', null, 'Animation'), animSel),
      slider('Size', t.size || 64, { min: 28, max: 140, step: 1, unit: '', onInput: (v) => updateClip(id, (x) => { ensureText(x).size = v; }, true) }),
      swatches(t.color, (col) => updateClip(id, (x) => { ensureText(x).color = col; }))));

    if (c.kind === 'video') {
      root.append(group('Sound',
        toggle('Mute this clip', c.muted, (v) => { updateClip(id, { muted: v }); renderTimeline(); }),
        slider('Volume', Math.round((c.volume ?? 1) * 100), { min: 0, max: 100, step: 1, unit: '%', onInput: (v) => updateClip(id, { volume: v / 100 }, true) })));
    }

    root.append(h('div', { class: 'group big-actions' },
      h('button', { class: 'btn', onclick: duplicateSelected }, icon('copy'), 'Duplicate'),
      h('button', { class: 'btn danger', onclick: deleteSelected }, icon('trash'), 'Delete clip')));
  }

  function applyAll(key, value) {
    commit(() => { S.timeline.display().forEach((c) => { if (key !== 'filter' || c.kind !== 'title') c[key] = value; }); });
    toast(`Applied to all clips`);
  }

  function renderOverview(root) {
    const clips = S.project.clips;
    root.append(h('div', { class: 'insp-head' }, h('div', null, h('h3', null, 'Reel overview'), h('p', null, clips.length ? 'Select a clip to edit it' : 'Start by adding media'))));
    root.append(h('div', { class: 'stat-row' },
      h('div', { class: 'stat' }, h('b', null, String(clips.length)), h('span', null, 'clips')),
      h('div', { class: 'stat' }, h('b', null, fmt(engine.total)), h('span', null, 'length')),
      h('div', { class: 'stat' }, h('b', null, S.project.aspect), h('span', null, 'format'))));
    if (engine.total > 90) root.append(h('p', { class: 'muted small' }, 'Heads up: Instagram Reels are best under 90 seconds.'));

    root.append(group('Quick start', h('div', { class: 'big-actions' },
      h('button', { class: 'btn primary', onclick: () => autoReel('bfs') }, icon('wand'), 'Auto Reel from library'),
      h('button', { class: 'btn', onclick: () => autoReel('dfs') }, icon('wand'), 'Auto Reel — deep-dive order'),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Groups similar shots together (BFS / DFS over a scene graph). You can undo it.'))));

    if (clips.length) {
      root.append(group('One-tap style',
        h('div', { class: 'field' }, h('label', null, 'Transition for every cut'), pills(TRANSITIONS, null, (v) => applyAll('transition', v))),
        h('div', { class: 'field' }, h('label', null, 'Filter for every clip'), (() => {
          const s = h('select'); s.append(h('option', { value: '' }, 'Choose a look…'));
          for (const [k, f] of Object.entries(FILTERS)) s.append(h('option', { value: k }, f.label));
          s.addEventListener('change', () => { if (s.value) applyAll('filter', s.value); });
          return s;
        })()),
        h('div', { class: 'field' }, h('label', null, 'Even out photo lengths'), pills({ fast: 'Fast 1.5s', normal: 'Normal 2.5s', slow: 'Slow 4s' }, null, (v) => {
          const sec = { fast: 1.5, normal: 2.5, slow: 4 }[v];
          commit(() => S.timeline.display().forEach((c) => { if (c.kind !== 'video') c.duration = sec; }));
        }))));
    }

    const cap = h('textarea', { rows: 3, placeholder: 'Write the caption you will post with this reel…' }); cap.value = S.project.caption || '';
    const sugg = h('div', { class: 'chips tag-suggest' });
    const updateSugg = async () => {
      const m = /#(\w*)$/.exec(cap.value.slice(0, cap.selectionStart));
      try {
        const tags = await API.hashtags(m ? m[1] : '');
        sugg.innerHTML = '';
        tags.slice(0, 8).forEach((tg) => sugg.append(h('button', { class: 'chip', onclick: () => {
          const pos = cap.selectionStart; const before = cap.value.slice(0, pos).replace(/#\w*$/, ''); const after = cap.value.slice(pos);
          cap.value = (before + (before && !/\s$/.test(before) ? ' ' : '') + tg + ' ' + after).replace(/\s+$/, ' ');
          S.project.caption = cap.value; scheduleSave(); cap.focus(); updateSugg();
        } }, tg)));
      } catch (e) { /* offline */ }
    };
    cap.addEventListener('input', () => { S.project.caption = cap.value; scheduleSave(); updateSugg(); });
    cap.addEventListener('click', updateSugg);
    updateSugg();
    root.append(group('Caption & hashtags', cap, sugg));

    root.append(group('Shortcuts', h('ul', { class: 'tip-list', html:
      '<li><kbd>Space</kbd> play / pause</li><li><kbd>S</kbd> split at playhead · <kbd>D</kbd> duplicate</li>' +
      '<li><kbd>Del</kbd> delete clip · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</li><li><kbd>←</kbd> <kbd>→</kbd> nudge playhead · drag clip edges to trim</li>' })));
  }

  async function autoReel(mode) {
    try {
      const { order } = await API.autoreel(mode);
      const clips = order.map((id) => S.library.find((m) => m.id === id)).filter(Boolean).map(clipFromMedia);
      if (!clips.length) return toast('Add some photos or videos first', 'error');
      const hadClips = S.timeline.size > 0;
      commit(() => { S.timeline.fromArray(clips); S.selectedId = null; });
      engine.seek(0);
      toast(`Built a ${clips.length}-clip reel`, 'ok', hadClips ? { label: 'Undo', fn: undo } : null);
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------------------------------------------------------------- text tab */
  function renderTextTab() {
    const grid = $('#titleGrid'); grid.innerHTML = '';
    TITLE_TEMPLATES.forEach((t) => {
      const f = TEXT_STYLES[t.style];
      grid.append(h('button', { class: 'tpl', style: { background: gradCss(t.bg), font: f.font.replace('{s}', 17), color: t.color || '#fff' }, title: 'Add title card',
        onclick: () => { addClips([titleClip(t)], { atPlayhead: true }); toast('Title card added'); } }, t.text));
    });
    const sg = $('#styleGrid'); sg.innerHTML = '';
    for (const [k, st] of Object.entries(TEXT_STYLES)) {
      sg.append(h('button', { class: 'style-btn', 'data-style': k, style: { font: st.font.replace('{s}', 20), ...(k === 'box' ? { color: '#111', background: '#fff' } : {}), ...(k === 'neon' ? { color: '#22d3ee', textShadow: '0 0 10px #22d3ee' } : {}) },
        onclick: () => {
          const c = selected(); if (!c) return toast('Select a clip in the timeline first', 'error');
          updateClip(c.id, (x) => { x.text = { content: 'Your text here', position: 'bottom', anim: 'fade', color: '#ffffff', size: 64, ...(x.text || {}), style: k }; if (!x.text.content) x.text.content = 'Your text here'; });
          renderInspector(); updateTextTab();
          const ta = $('#inspector textarea'); if (ta) { ta.focus(); ta.select(); }
        } }, st.label));
    }
    updateTextTab();
  }
  function updateTextTab() {
    const c = selected();
    $('#styleGrid').classList.toggle('disabled', !c);
    $('#textHint').textContent = c ? `Editing “${c.name}”. Pick a style, then type in the panel on the right.` : 'Select a clip in the timeline, then pick a style.';
    $$('#styleGrid .style-btn').forEach((b) => b.classList.toggle('active', !!(c && c.text && c.text.content && c.text.style === b.dataset.style)));
  }

  /* --------------------------------------------------------------- music */
  function setMusic(m) {
    commit(() => { S.project.music = m ? { mediaId: m.id, src: '/media/' + m.file, name: m.name, volume: 0.7, start: 0, duration: m.duration || 0 } : null; });
    if (m) toast('Music added');
  }
  function renderMusic() {
    const root = $('#musicCurrent'); root.innerHTML = '';
    const m = S.project.music;
    if (!m) return;
    root.append(
      h('div', { class: 'name' }, icon('music'), h('span', null, m.name), h('button', { class: 'icon-btn sm', title: 'Remove music', onclick: () => setMusic(null) }, icon('x'))),
      slider('Music volume', Math.round((m.volume ?? 0.7) * 100), { min: 0, max: 100, step: 1, unit: '%', onInput: (v) => live(() => { S.project.music.volume = v / 100; }) }),
      m.duration ? slider('Start song at', m.start || 0, { min: 0, max: Math.max(0, m.duration - 1).toFixed(1), onInput: (v) => live(() => { S.project.music.start = v; }) }) : null,
    );
  }
  function renderAudioList() {
    const root = $('#audioList'); root.innerHTML = '';
    const audio = S.library.filter((m) => m.kind === 'audio');
    if (!audio.length) { root.append(h('p', { class: 'muted small' }, 'No songs yet. Upload one above.')); return; }
    audio.forEach((m) => root.append(h('div', { class: 'audio-item' }, icon('music'), h('span', null, m.name), h('span', { class: 'muted', style: { flex: 'none' } }, fmt(m.duration)),
      h('button', { class: 'btn sm', onclick: () => setMusic(m) }, S.project && S.project.music && S.project.music.mediaId === m.id ? 'In use' : 'Use'))));
  }

  /* ------------------------------------------------------------------ AI */
  const IDEAS = {
    image: ['Cozy café window, rain outside, golden light', 'Neon city street at night, reflections, cinematic', 'Minimal product shot on pastel background', 'Aerial view of turquoise beach, drone shot'],
    video: ['Slow-motion coffee pour, warm morning light', 'Drone flying over misty mountains at sunrise', 'Hands typing on a laptop, shallow depth of field', 'Confetti falling in slow motion, party lights'],
    animate: ['Gentle camera push-in, hair moving in the wind', 'Clouds drifting, subtle parallax', 'Steam rising, soft cinematic motion'],
  };
  function renderAI() {
    $$('#aiType button').forEach((b) => b.classList.toggle('active', b.dataset.type === S.aiType));
    $('#animateSource').hidden = S.aiType !== 'animate';
    const models = S.models[S.aiType] || [];
    const sel = $('#aiModel'); sel.innerHTML = '';
    models.forEach((m) => sel.append(h('option', { value: m.id }, m.name)));
    renderDurations();
    const ideas = $('#aiIdeas'); ideas.innerHTML = '';
    IDEAS[S.aiType].forEach((t) => ideas.append(h('button', { class: 'chip', onclick: () => { $('#aiPrompt').value = t; } }, t)));
    $('#aiPrompt').placeholder = S.aiType === 'animate' ? 'How should it move? (optional)' : IDEAS[S.aiType][0];
    $('#keyBanner').hidden = S.hasKey;
  }
  function renderDurations() {
    const m = (S.models[S.aiType] || []).find((x) => x.id === $('#aiModel').value);
    const wrap = $('#aiDurWrap'); const sel = $('#aiDuration'); sel.innerHTML = '';
    wrap.hidden = S.aiType === 'image' || !m || !m.durations;
    if (m && m.durations) m.durations.forEach((d) => sel.append(h('option', { value: d }, d + ' seconds')));
  }
  function renderAnimateSources() {
    const sel = $('#aiSource'); sel.innerHTML = '';
    const imgs = S.library.filter((m) => m.kind === 'image');
    if (!imgs.length) sel.append(h('option', { value: '' }, 'Upload or generate a photo first'));
    imgs.forEach((m) => sel.append(h('option', { value: m.id }, m.name)));
  }
  async function generate() {
    if (!S.hasKey) { openModal('settings'); return toast('Add your MuAPI key to use AI', 'error'); }
    const prompt = $('#aiPrompt').value.trim();
    if (!prompt && S.aiType !== 'animate') { $('#aiPrompt').focus(); return toast('Describe what you want first', 'error'); }
    const body = { type: S.aiType, prompt, model: $('#aiModel').value, duration: $('#aiDuration').value, aspect_ratio: S.project.aspect };
    if (S.aiType === 'animate') { body.sourceId = $('#aiSource').value; if (!body.sourceId) return toast('Pick a photo to animate', 'error'); }
    try { await API.generate(body); toast('Queued — it will drop into your reel when ready'); pollJobs(); }
    catch (e) { toast(e.message, 'error'); }
  }
  const seenJobs = new Set();
  let jobTimer = null;
  async function pollJobs() {
    clearTimeout(jobTimer);
    let list = [];
    try { list = await API.jobs(); } catch (e) { return; }
    const root = $('#jobs'); root.innerHTML = '';
    if (!list.length) root.append(h('p', { class: 'muted small' }, 'Generations appear here, then land in your Media library.'));
    let newDone = false;
    for (const j of list) {
      root.append(h('div', { class: 'job ' + j.status },
        h('div', { class: 'top' }, h('span', { class: 'prompt' }, (j.type === 'image' ? '🖼 ' : '🎬 ') + j.prompt),
          j.status !== 'running' ? h('button', { class: 'icon-btn sm', title: 'Remove', onclick: async () => { await API.cancelJob(j.id); pollJobs(); } }, icon('x')) : null),
        h('span', { class: 'status' }, j.status === 'queued' ? 'Waiting…' : j.message)));
      if (j.status === 'done' && !seenJobs.has(j.id)) {
        seenJobs.add(j.id);
        if (S.jobsPrimed) newDone = j;
      }
      if (j.status !== 'done') seenJobs.add(j.id + ':seen');
    }
    S.jobsPrimed = true;
    if (newDone) {
      await loadLibrary();
      const m = S.library.find((x) => x.id === newDone.mediaId);
      if (m) {
        // probe real duration for generated videos
        if (m.kind === 'video') await new Promise((r) => { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => { m.duration = v.duration; API.patchMedia(m.id, { duration: v.duration, width: v.videoWidth, height: v.videoHeight }).catch(() => {}); r(); }; v.onerror = r; v.src = '/media/' + m.file; });
        addClips([clipFromMedia(m)]);
        toast('AI ' + (m.kind === 'image' ? 'photo' : 'video') + ' added to your reel');
      }
    }
    if (list.some((j) => j.status === 'queued' || j.status === 'running')) jobTimer = setTimeout(pollJobs, 2000);
  }

  /* -------------------------------------------------------------- chrome */
  function updateChrome() {
    $('#undoBtn').disabled = !S.history.canUndo;
    $('#redoBtn').disabled = !S.history.canRedo;
    const has = S.project.clips.length > 0;
    $('#emptyState').hidden = has;
    $('#bigPlay').hidden = !has || engine.playing;
    $('#totTime').textContent = fmt(engine.total);
    const phone = $('#phone'); phone.classList.toggle('a45', S.project.aspect === '4:5'); phone.classList.toggle('a11', S.project.aspect === '1:1');
    $$('#aspectSeg button').forEach((b) => b.classList.toggle('active', b.dataset.aspect === S.project.aspect));
    const steps = $$('.steps li');
    const cur = !has ? 1 : S.exported ? 3 : 2;
    steps.forEach((li, i) => { li.classList.toggle('done', i + 1 < cur || (S.exported && i === 2)); li.classList.toggle('current', i + 1 === cur && !(S.exported && i === 2)); });
  }

  function openModal(name) { $('#' + name + 'Modal').hidden = false; if (name === 'settings') loadSettings(); if (name === 'projects') renderProjects(); }
  function closeModals() { $$('.modal').forEach((m) => { if (m.id === 'exportModal' && engine.exporting) return; m.hidden = true; }); }

  async function loadSettings() {
    try { const s = await API.settings(); S.hasKey = s.hasKey; $('#keyStatus').textContent = s.keyFromEnv ? 'Using the key from the MUAPI_KEY environment variable.' : s.hasKey ? 'A key is saved. Paste a new one to replace it.' : 'No key yet — AI generation is off.'; }
    catch (e) { $('#keyStatus').textContent = 'Backend not reachable.'; }
    renderAI();
  }
  async function renderProjects() {
    const root = $('#projectList'); root.innerHTML = '';
    const list = await API.projects();
    list.forEach((p) => root.append(h('div', { class: 'project-item' + (p.id === S.project.id ? ' current' : ''), onclick: async () => { await openProject(p.id); closeModals(); } },
      icon('film'), h('div', null, h('b', null, p.name), h('span', null, `${p.clips} clips · ${new Date(p.updatedAt).toLocaleString()}`)),
      h('button', { class: 'icon-btn sm', title: 'Delete project', onclick: async (e) => {
        e.stopPropagation(); if (!confirm(`Delete project "${p.name}"?`)) return;
        await API.deleteProject(p.id);
        if (p.id === S.project.id) { const rest = list.filter((x) => x.id !== p.id); rest.length ? await openProject(rest[0].id) : await newProject(); }
        renderProjects();
      } }, icon('trash')))));
  }

  /* -------------------------------------------------------------- export */
  let quality = 8;
  function openExport() {
    if (!S.project.clips.length) return toast('Add some clips before exporting', 'error');
    engine.pause();
    $('#exportSetup').hidden = false; $('#exportRun').hidden = true; $('#exportDone').hidden = true;
    $('#exportStart').hidden = false; $('#exportDownload').hidden = true; $('#copyCaption').hidden = true;
    $('#exportTitle').textContent = 'Export your reel';
    $('#exportCancel').textContent = 'Close';
    $('#captionOut').value = S.project.caption || '';
    renderExportTags();
    openModal('export');
  }
  async function renderExportTags() {
    const words = ($('#captionOut').value.match(/[a-z]{3,}/gi) || []).slice(-3);
    const box = $('#exportTags'); box.innerHTML = '';
    const set = new Set();
    for (const w of words.length ? words : ['reel']) { try { (await API.hashtags(w.slice(0, 4))).forEach((t) => set.add(t)); } catch (e) { /* */ } }
    if (set.size < 4) (await API.hashtags('re').catch(() => [])).forEach((t) => set.add(t));
    [...set].slice(0, 10).forEach((t) => box.append(h('button', { class: 'chip', onclick: (e) => { const ta = $('#captionOut'); if (!ta.value.includes(t)) ta.value = (ta.value.trim() + ' ' + t).trim(); S.project.caption = ta.value; scheduleSave(); e.currentTarget.classList.add('active'); } }, t)));
  }
  async function startExport() {
    $('#exportSetup').hidden = true; $('#exportRun').hidden = false; $('#exportStart').hidden = true;
    $('#exportTitle').textContent = 'Rendering your reel…';
    $('#exportCancel').textContent = 'Cancel';
    $('#exportMsg').textContent = 'Recording in real time — keep this tab open.';
    try {
      await document.fonts.ready;
      const blob = await engine.export({ bitrate: quality * 1e6, onProgress: (p) => { $('#exportBar').style.width = Math.round(p * 100) + '%'; $('#exportMsg').textContent = `Recording… ${Math.round(p * 100)}%`; } });
      if (!blob) { $('#exportModal').hidden = true; return toast('Export cancelled', 'error'); }
      const url = URL.createObjectURL(blob);
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const name = (S.project.name || 'reel').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'reel';
      $('#exportVideo').src = url;
      const a = $('#exportDownload'); a.href = url; a.download = `${name}.${ext}`; a.hidden = false; a.textContent = `Download .${ext}`;
      $('#exportRun').hidden = true; $('#exportDone').hidden = false;
      $('#exportInfo').textContent = `${fmt(engine.total)} · ${fmtBytes(blob.size)} · ${ext.toUpperCase()}${ext === 'webm' ? ' (Instagram and TikTok accept it; convert to MP4 if a site refuses it)' : ''}`;
      $('#copyCaption').hidden = !S.project.caption;
      $('#exportTitle').textContent = 'Your reel is ready 🎉';
      $('#exportCancel').textContent = 'Close';
      S.exported = true; updateChrome();
      a.click();
    } catch (e) {
      $('#exportModal').hidden = true;
      toast(e.message, 'error');
    }
  }

  /* ---------------------------------------------------------- bindings */
  function bind() {
    // tabs
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.tab-body').forEach((b) => b.classList.toggle('active', b.dataset.body === t.dataset.tab));
      if (t.dataset.tab === 'ai') { renderAI(); pollJobs(); }
      if (t.dataset.tab === 'text') updateTextTab();
    }));

    // uploads
    $('#fileInput').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
    $('#musicInput').addEventListener('change', (e) => { uploadFiles(e.target.files, { useAsMusic: true }); e.target.value = ''; });
    for (const dz of [$('#dropzone'), $('#musicDrop')]) {
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); uploadFiles(e.dataTransfer.files, { useAsMusic: dz.id === 'musicDrop' }); });
    }
    // drop files anywhere on the preview
    $('#previewWrap').addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    $('#previewWrap').addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); uploadFiles(e.dataTransfer.files); } });

    // library tools
    let qTimer;
    $('#libSearch').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.libQuery = e.target.value; loadLibrary(); }, 200); });
    $('#libSort').addEventListener('change', (e) => { S.libSort = e.target.value; loadLibrary(); });
    $$('#libKinds .chip').forEach((c) => c.addEventListener('click', () => { $$('#libKinds .chip').forEach((x) => x.classList.toggle('active', x === c)); S.libKind = c.dataset.kind; loadLibrary(); }));

    // empty state
    $('[data-action="upload"]').addEventListener('click', () => $('#fileInput').click());
    $('[data-action="sample"]').addEventListener('click', () => {
      addClips([TITLE_TEMPLATES[0], TITLE_TEMPLATES[2], TITLE_TEMPLATES[5], TITLE_TEMPLATES[3]].map(titleClip));
      engine.seek(0); engine.play();
      toast('Sample reel created — click a clip to edit it');
    });

    // transport
    $('#playBtn').addEventListener('click', () => engine.toggle());
    $('#bigPlay').addEventListener('click', () => engine.play());
    $('#canvas').addEventListener('click', () => S.project.clips.length && engine.toggle());
    $('#toStart').addEventListener('click', () => engine.seek(0));
    engine.on('time', (t) => { $('#curTime').textContent = fmt(t); positionPlayhead(); followPlayhead(); });
    engine.on('state', (playing) => {
      $('#playIcon').firstElementChild.setAttribute('href', playing ? '#i-pause' : '#i-play');
      $('#bigPlay').hidden = playing || !S.project.clips.length;
    });

    // aspect
    $$('#aspectSeg button').forEach((b) => b.addEventListener('click', () => commit(() => { S.project.aspect = b.dataset.aspect; })));
    $('#autoReelBtn').addEventListener('click', () => autoReel('bfs'));

    // timeline tools
    $('#splitBtn').addEventListener('click', splitAtPlayhead);
    $('#dupBtn').addEventListener('click', duplicateSelected);
    $('#delBtn').addEventListener('click', deleteSelected);
    $('#tlZoom').addEventListener('input', (e) => setZoom(+e.target.value));
    setupTrackDnD(); setupScrub();
    $('#track').addEventListener('click', (e) => { if (e.target === $('#track')) select(null); });

    // top bar
    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#projectName').addEventListener('input', scheduleSave);
    $('#projectName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    $('#settingsBtn').addEventListener('click', () => openModal('settings'));
    $('#openProjects').addEventListener('click', () => openModal('projects'));
    $('#newProject').addEventListener('click', async () => { await newProject(); closeModals(); toast('New reel started'); });
    $('#exportBtn').addEventListener('click', openExport);
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.open)));

    // modals
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => { if (engine.exporting) { engine.cancelExport(); return; } closeModals(); }));
    $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m && !engine.exporting) closeModals(); }));
    $('#saveKey').addEventListener('click', async () => {
      const v = $('#keyInput').value.trim();
      if (!v) return toast('Paste a key first', 'error');
      try { const r = await API.saveKey(v); S.hasKey = r.hasKey; $('#keyInput').value = ''; closeModals(); renderAI(); toast('Key saved — AI is ready'); }
      catch (e) { toast(e.message, 'error'); }
    });
    $('#dsList').innerHTML = [
      ['Exp 1–2', 'Array insert/delete + linear search', 'media library & search'],
      ['Exp 3', 'Binary search', 'finds the clip under the playhead'],
      ['Exp 4', 'Doubly linked list', 'the timeline (reorder, split, insert)'],
      ['Exp 5', 'Stack', 'undo / redo'],
      ['Exp 6', 'Infix → postfix', 'type sums like 2*1.5 in number fields'],
      ['Exp 7', 'Linked-list queue', 'AI generation queue on the backend'],
      ['Exp 8–10, 12', 'Insertion / quick / merge / heap sort', 'library sorting'],
      ['Exp 11', 'Binary search tree', 'hashtag suggestions'],
      ['Exp 13', 'BFS / DFS', 'Auto Reel scene ordering'],
    ].map(([e, what, use]) => `<li><b>${e}</b> ${what} → ${use}</li>`).join('');

    // AI
    $$('#aiType button').forEach((b) => b.addEventListener('click', () => { S.aiType = b.dataset.type; renderAI(); }));
    $('#aiModel').addEventListener('change', renderDurations);
    $('#aiGo').addEventListener('click', generate);

    // export
    $$('#qualitySeg button').forEach((b) => b.addEventListener('click', () => { $$('#qualitySeg button').forEach((x) => x.classList.toggle('active', x === b)); quality = +b.dataset.q; }));
    $('#exportStart').addEventListener('click', startExport);
    $('#captionOut').addEventListener('input', (e) => { S.project.caption = e.target.value; scheduleSave(); });
    $('#copyCaption').addEventListener('click', async () => { try { await navigator.clipboard.writeText(S.project.caption || ''); toast('Caption copied'); } catch (e) { toast('Could not copy', 'error'); } });

    // mobile nav
    $$('#mobileNav button').forEach((b) => b.addEventListener('click', () => {
      $$('#mobileNav button').forEach((x) => x.classList.toggle('active', x === b));
      $('#app').dataset.m = b.dataset.m;
      if (b.dataset.m === 'stage') engine.invalidate();
    }));
    $('#app').dataset.m = 'left';

    // keyboard
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
      if (e.key === 'Escape') { if (!$$('.modal').every((m) => m.hidden)) closeModals(); else select(null); return; }
      if (typing || mod) return;
      if (e.key === ' ') { e.preventDefault(); engine.toggle(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected()) { e.preventDefault(); deleteSelected(); } }
      else if (e.key.toLowerCase() === 's') splitAtPlayhead();
      else if (e.key.toLowerCase() === 'd') duplicateSelected();
      else if (e.key === 'ArrowLeft') engine.seek(engine.t - (e.shiftKey ? 1 : 1 / 10));
      else if (e.key === 'ArrowRight') engine.seek(engine.t + (e.shiftKey ? 1 : 1 / 10));
      else if (e.key === 'Home') engine.seek(0);
    });
    window.addEventListener('resize', () => renderTimeline());
    document.fonts && document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', () => engine.invalidate());
  }

  function followPlayhead() {
    if (!engine.playing) return;
    const tl = $('#timeline'); const x = engine.t * S.pps;
    if (x > tl.scrollLeft + tl.clientWidth - 60 || x < tl.scrollLeft) tl.scrollLeft = Math.max(0, x - 60);
  }

  /* ----------------------------------------------------------------- boot */
  async function boot() {
    S.pps = +(safeLS.get('reel_zoom') || 70); $('#tlZoom').value = S.pps;
    bind();
    renderTextTab();
    try {
      const [settings, models] = await Promise.all([API.settings(), API.models()]);
      S.hasKey = settings.hasKey; S.models = models;
    } catch (e) {
      toast('Cannot reach the backend. Start it with: npm start', 'error');
      return;
    }
    await loadLibrary();
    const list = await API.projects();
    const last = safeLS.get('reel_project');
    const pick = list.find((p) => p.id === last) || list[0];
    if (pick) await openProject(pick.id); else await newProject();
    renderAI();
    pollJobs();
  }
  boot();
})();
