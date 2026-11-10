/*
 * engine.js — renders a reel onto a <canvas>, plays it back with audio,
 * and records it to a video file with MediaRecorder.
 *
 * Clip lookup at any time t uses binary search over clip start times (Exp 3).
 */
(function (global) {
  'use strict';

  const TD = 0.5; // transition length, seconds

  const ASPECTS = {
    '9:16': { w: 720, h: 1280, label: 'Reel / Story 9:16' },
    '4:5': { w: 864, h: 1080, label: 'Feed 4:5' },
    '1:1': { w: 1080, h: 1080, label: 'Square 1:1' },
  };

  const FILTERS = {
    none: { label: 'Original', css: 'none' },
    vivid: { label: 'Vivid', css: 'saturate(1.45) contrast(1.08)' },
    warm: { label: 'Golden', css: 'sepia(.22) saturate(1.35) brightness(1.04)' },
    cool: { label: 'Cool', css: 'hue-rotate(-10deg) saturate(1.15) brightness(1.02)' },
    bw: { label: 'Mono', css: 'grayscale(1) contrast(1.12)' },
    vintage: { label: 'Vintage', css: 'sepia(.45) contrast(.92) brightness(1.06) saturate(.9)' },
    fade: { label: 'Matte', css: 'contrast(.86) brightness(1.1) saturate(.82)' },
    drama: { label: 'Drama', css: 'contrast(1.3) saturate(1.1) brightness(.92)' },
  };

  const TRANSITIONS = {
    cut: 'Cut', fade: 'Fade', slide: 'Slide', zoom: 'Zoom', wipe: 'Wipe', flash: 'Flash',
  };

  const MOTIONS = { none: 'Still', zoomIn: 'Zoom in', zoomOut: 'Zoom out', panLeft: 'Pan left', panRight: 'Pan right' };

  const TEXT_STYLES = {
    bold: { label: 'Bold', font: '800 {s}px Inter, system-ui, sans-serif' },
    box: { label: 'Boxed', font: '700 {s}px Inter, system-ui, sans-serif' },
    neon: { label: 'Neon', font: '800 {s}px "Space Grotesk", Inter, sans-serif' },
    outline: { label: 'Poster', font: '400 {s}px "Bebas Neue", Impact, sans-serif', scale: 1.35 },
    script: { label: 'Script', font: '400 {s}px Pacifico, cursive', scale: 1.05 },
  };
  const TEXT_ANIMS = { none: 'None', fade: 'Fade in', pop: 'Pop', slideUp: 'Slide up', typewriter: 'Typewriter' };

  const BACKGROUNDS = {
    sunset: ['#ff7a59', '#ff3d77', '#7b2ff7'],
    ocean: ['#00c6ff', '#0072ff', '#1b1464'],
    mint: ['#a8ff78', '#2bd2a8', '#0f766e'],
    night: ['#0f0c29', '#302b63', '#24243e'],
    candy: ['#f9a8d4', '#c084fc', '#818cf8'],
    mono: ['#111111', '#222222', '#000000'],
    paper: ['#fdfbf7', '#f3ede2', '#e9dfcc'],
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);

  class Engine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.project = { clips: [], aspect: '9:16' };
      this.starts = [];
      this.total = 0;
      this.t = 0;
      this.playing = false;
      this.els = new Map(); // src -> media element
      this.clipEls = new Map(); // clip.id -> video element (each video clip owns one)
      this.audio = null;
      this.music = null;
      this.listeners = {};
      this._raf = null;
      this._needsDraw = true;
      this._loop = this._loop.bind(this);
      this.setAspect('9:16');
      requestAnimationFrame(this._loop);
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, d) { (this.listeners[ev] || []).forEach((f) => f(d)); }

    setAspect(a) {
      const s = ASPECTS[a] || ASPECTS['9:16'];
      if (this.canvas.width !== s.w || this.canvas.height !== s.h) { this.canvas.width = s.w; this.canvas.height = s.h; }
      this.invalidate();
    }

    setProject(project) {
      this.project = project;
      this.setAspect(project.aspect);
      // prefix sums of durations -> start time of each clip
      this.starts = []; let acc = 0;
      for (const c of project.clips) { this.starts.push(acc); acc += Math.max(0.2, Number(c.duration) || 0); }
      this.total = acc;
      if (this.t > this.total) this.t = this.total;
      // prepare media
      const live = new Set();
      for (const c of project.clips) {
        if (c.kind === 'video') { this._videoFor(c); live.add(c.id); }
        else if (c.kind === 'image') this._imageFor(c.src);
      }
      for (const [id, v] of this.clipEls) if (!live.has(id)) { v.pause(); v.removeAttribute('src'); v.load(); this.clipEls.delete(id); }
      this._setupMusic(project.music);
      this.invalidate();
      this.emit('time', this.t);
    }

    _imageFor(src) {
      if (this.els.has(src)) return this.els.get(src);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => this.invalidate();
      img.src = src;
      this.els.set(src, img);
      return img;
    }

    _videoFor(c) {
      let v = this.clipEls.get(c.id);
      if (v && v.dataset.src === c.src) return v;
      if (v) { v.pause(); }
      v = document.createElement('video');
      v.dataset.src = c.src;
      v.src = c.src; v.preload = 'auto'; v.playsInline = true; v.muted = false; v.crossOrigin = 'anonymous';
      v.addEventListener('loadeddata', () => this.invalidate());
      v.addEventListener('seeked', () => this.invalidate());
      this.clipEls.set(c.id, v);
      if (this.audio) this._wireAudio(v);
      return v;
    }

    _setupMusic(m) {
      const src = m && m.src;
      if (this.music && this.music.dataset.src === src) { this._applyVolumes(); return; }
      if (this.music) { this.music.pause(); this.music = null; }
      if (!src) return;
      const a = new Audio(); a.dataset.src = src; a.src = src; a.preload = 'auto'; a.crossOrigin = 'anonymous'; a.loop = true;
      this.music = a;
      if (this.audio) this._wireAudio(a);
      this._applyVolumes();
    }

    // Web Audio graph: every element -> gain -> master -> speakers + recorder
    ensureAudio() {
      if (this.audio) { if (this.audio.ctx.state === 'suspended') this.audio.ctx.resume(); return; }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const master = ctx.createGain();
      const rec = ctx.createMediaStreamDestination();
      master.connect(ctx.destination); master.connect(rec);
      this.audio = { ctx, master, rec, gains: new Map() };
      for (const v of this.clipEls.values()) this._wireAudio(v);
      if (this.music) this._wireAudio(this.music);
      this._applyVolumes();
    }
    _wireAudio(el) {
      if (!this.audio || this.audio.gains.has(el)) return;
      try {
        const src = this.audio.ctx.createMediaElementSource(el);
        const g = this.audio.ctx.createGain();
        src.connect(g); g.connect(this.audio.master);
        this.audio.gains.set(el, g);
      } catch (e) { /* element already wired */ }
    }
    _applyVolumes() {
      for (const c of this.project.clips) {
        const v = this.clipEls.get(c.id);
        if (!v) continue;
        const vol = c.muted ? 0 : clamp(c.volume ?? 1, 0, 1);
        const g = this.audio && this.audio.gains.get(v);
        if (g) g.gain.value = vol; else v.volume = vol;
      }
      if (this.music) {
        const vol = clamp(this.project.music?.volume ?? 0.7, 0, 1);
        const g = this.audio && this.audio.gains.get(this.music);
        if (g) g.gain.value = vol; else this.music.volume = vol;
      }
    }

    invalidate() { this._needsDraw = true; }

    indexAt(t) {
      if (!this.starts.length) return -1;
      if (!Number.isFinite(t)) t = 0;
      const i = DS.binarySearchStart(this.starts, clamp(t, 0, Math.max(0, this.total - 1e-4)));
      return clamp(i, 0, this.starts.length - 1);
    }

    play() {
      if (!this.project.clips.length) return;
      this.ensureAudio();
      if (this.t >= this.total - 0.05) this.t = 0;
      this.playing = true;
      this._wall = performance.now(); this._t0 = this.t;
      this.emit('state', true);
    }
    pause() {
      this.playing = false;
      for (const v of this.clipEls.values()) v.pause();
      if (this.music) this.music.pause();
      this._syncMedia(false);
      this.emit('state', false);
      this.invalidate();
    }
    toggle() { this.playing ? this.pause() : this.play(); }
    seek(t) {
      this.t = clamp(t, 0, this.total);
      if (this.playing) { this._wall = performance.now(); this._t0 = this.t; }
      this._syncMedia(this.playing, true);
      this.invalidate();
      this.emit('time', this.t);
    }

    _loop(now) {
      requestAnimationFrame(this._loop);
      if (this.playing) {
        this.t = this._t0 + (now - this._wall) / 1000;
        if (this.t >= this.total) {
          this.t = this.total;
          this.pause();
          this.emit('ended');
        } else this._syncMedia(true);
        this.emit('time', this.t);
        this._draw();
      } else if (this._needsDraw) {
        this._draw();
      }
    }

    _syncMedia(playing, force) {
      const i = this.indexAt(this.t);
      const clips = this.project.clips;
      clips.forEach((c, k) => {
        if (c.kind !== 'video') return;
        const v = this.clipEls.get(c.id);
        if (!v) return;
        if (k === i) {
          const want = (c.trimIn || 0) + (this.t - this.starts[k]);
          const target = v.duration ? Math.min(want, v.duration - 0.05) : want;
          if (playing) {
            if (v.paused) { if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target; v.play().catch(() => {}); }
            else if (force || Math.abs(v.currentTime - target) > 0.35) v.currentTime = target;
          } else if (v.readyState >= 1 && Math.abs(v.currentTime - target) > 0.03) {
            v.currentTime = target;
          }
        } else if (!v.paused) v.pause();
      });
      if (this.music) {
        const m = this.music;
        const offset = this.project.music?.start || 0;
        const want = m.duration ? (this.t + offset) % m.duration : this.t + offset;
        if (playing) {
          if (m.paused) { m.currentTime = want; m.play().catch(() => {}); }
          else if (force || Math.abs(m.currentTime - want) > 0.4) m.currentTime = want;
        }
      }
    }

    /* ---------------------------------------------------------- drawing */
    _draw() {
      this._needsDraw = false;
      const { ctx, canvas } = this; const W = canvas.width, H = canvas.height;
      ctx.save();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      const clips = this.project.clips;
      if (!clips.length) { ctx.restore(); return; }
      const i = this.indexAt(this.t);
      const c = clips[i];
      if (!c) { ctx.restore(); return; }
      const local = this.t - this.starts[i];
      const tr = c.transition || 'cut';
      if (i > 0 && tr !== 'cut' && local < TD) {
        const prev = clips[i - 1];
        const p = ease(local / TD);
        this._drawTransition(tr, p, () => this._drawClip(prev, prev.duration), () => this._drawClip(c, local));
      } else {
        this._drawClip(c, local);
      }
      ctx.restore();
    }

    _drawTransition(tr, p, drawPrev, drawCur) {
      const { ctx, canvas } = this; const W = canvas.width, H = canvas.height;
      if (tr === 'fade') { drawPrev(); ctx.save(); ctx.globalAlpha = p; drawCur(); ctx.restore(); }
      else if (tr === 'slide') {
        ctx.save(); ctx.translate(-p * W, 0); drawPrev(); ctx.restore();
        ctx.save(); ctx.translate((1 - p) * W, 0); drawCur(); ctx.restore();
      } else if (tr === 'zoom') {
        drawPrev();
        ctx.save(); ctx.globalAlpha = p; const s = 1.35 - 0.35 * p;
        ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2); drawCur(); ctx.restore();
      } else if (tr === 'wipe') {
        drawPrev(); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * p, H); ctx.clip(); drawCur(); ctx.restore();
      } else if (tr === 'flash') {
        drawCur(); ctx.save(); ctx.globalAlpha = 1 - p; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore();
      } else drawCur();
    }

    _drawClip(c, local) {
      const { ctx, canvas } = this; const W = canvas.width, H = canvas.height;
      const dur = Math.max(0.2, Number(c.duration) || 0);
      const prog = clamp(local / dur, 0, 1);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
      ctx.filter = (FILTERS[c.filter] || FILTERS.none).css;
      if (c.kind === 'title') {
        const stops = BACKGROUNDS[c.bg] || BACKGROUNDS.sunset;
        const g = ctx.createLinearGradient(0, 0, W, H);
        stops.forEach((s, k) => g.addColorStop(k / (stops.length - 1), s));
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        // slow drifting glow so title cards feel alive
        const r = ctx.createRadialGradient(W * (0.3 + 0.4 * prog), H * 0.35, 0, W * 0.5, H * 0.4, W);
        r.addColorStop(0, 'rgba(255,255,255,.22)'); r.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = r; ctx.fillRect(0, 0, W, H);
      } else {
        const el = c.kind === 'video' ? this.clipEls.get(c.id) : this.els.get(c.src) || this._imageFor(c.src);
        const sw = c.kind === 'video' ? el && el.videoWidth : el && el.naturalWidth;
        const sh = c.kind === 'video' ? el && el.videoHeight : el && el.naturalHeight;
        if (el && sw && sh && (c.kind !== 'video' || el.readyState >= 2)) {
          let scale = c.fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
          let dx = 0;
          const m = c.motion || 'none';
          if (m === 'zoomIn') scale *= 1 + 0.15 * prog;
          else if (m === 'zoomOut') scale *= 1.15 - 0.15 * prog;
          else if (m === 'panLeft' || m === 'panRight') scale *= 1.18;
          const dw = sw * scale, dh = sh * scale;
          if (m === 'panLeft') dx = (dw - W) / 2 * (1 - 2 * prog);
          if (m === 'panRight') dx = -(dw - W) / 2 * (1 - 2 * prog);
          if (c.fit === 'contain') { // blurred backdrop fill
            ctx.save(); ctx.filter = 'blur(28px) brightness(.6)';
            const bs = Math.max(W / sw, H / sh) * 1.1;
            ctx.drawImage(el, (W - sw * bs) / 2, (H - sh * bs) / 2, sw * bs, sh * bs); ctx.restore();
            ctx.filter = (FILTERS[c.filter] || FILTERS.none).css;
          }
          ctx.drawImage(el, (W - dw) / 2 + dx, (H - dh) / 2, dw, dh);
        } else {
          ctx.fillStyle = '#16161d'; ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '600 28px Inter, sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('Loading…', W / 2, H / 2);
        }
      }
      ctx.filter = 'none';
      if (c.text && c.text.content) this._drawText(c.text, local, dur);
      ctx.restore();
    }

    _drawText(tx, local, dur) {
      const { ctx, canvas } = this; const W = canvas.width, H = canvas.height;
      const style = TEXT_STYLES[tx.style] || TEXT_STYLES.bold;
      const base = (tx.size || 64) * (W / 720) * (style.scale || 1);
      let content = tx.content;
      const anim = tx.anim || 'fade';
      const inP = clamp(local / 0.45, 0, 1);
      const outP = clamp((dur - local) / 0.3, 0, 1);
      let alpha = 1, dy = 0, scale = 1;
      if (anim === 'fade') alpha = ease(inP) * outP;
      else if (anim === 'pop') { const p = clamp(local / 0.35, 0, 1); scale = p < 1 ? 0.6 + 0.55 * ease(p) - 0.15 * Math.max(0, (p - 0.7) / 0.3) : 1; alpha = Math.min(1, p * 3) * outP; }
      else if (anim === 'slideUp') { dy = (1 - ease(inP)) * 80; alpha = ease(inP) * outP; }
      else if (anim === 'typewriter') { const n = Math.floor(content.length * clamp(local / Math.min(1.6, dur * 0.6), 0, 1)); content = content.slice(0, n); }

      ctx.save();
      ctx.font = style.font.replace('{s}', Math.round(base));
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const maxW = W * 0.84;
      const lines = [];
      for (const para of content.split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
          const test = line ? line + ' ' + word : word;
          if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
        }
        lines.push(line);
      }
      const lh = base * 1.22;
      const blockH = lines.length * lh;
      const pos = tx.position || 'center';
      const cy = pos === 'top' ? H * 0.17 + blockH / 2 : pos === 'bottom' ? H * 0.8 - blockH / 2 : H / 2;
      ctx.globalAlpha = alpha;
      ctx.translate(W / 2, cy + dy); ctx.scale(scale, scale);
      const color = tx.color || '#ffffff';
      lines.forEach((ln, k) => {
        const y = -blockH / 2 + lh * k + lh / 2;
        if (tx.style === 'box') {
          const w = ctx.measureText(ln).width + base * 0.7;
          ctx.fillStyle = color; roundRect(ctx, -w / 2, y - lh / 2 + 2, w, lh - 4, base * 0.22); ctx.fill();
          ctx.fillStyle = isLight(color) ? '#111' : '#fff'; ctx.fillText(ln, 0, y + 2);
        } else if (tx.style === 'neon') {
          ctx.shadowColor = color; ctx.shadowBlur = base * 0.5; ctx.fillStyle = '#fff';
          ctx.fillText(ln, 0, y); ctx.shadowBlur = base * 0.25; ctx.fillStyle = color; ctx.fillText(ln, 0, y);
        } else if (tx.style === 'outline') {
          ctx.lineJoin = 'round'; ctx.lineWidth = base * 0.12; ctx.strokeStyle = '#000'; ctx.strokeText(ln, 0, y);
          ctx.fillStyle = color; ctx.fillText(ln, 0, y);
        } else {
          ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = base * 0.25; ctx.shadowOffsetY = base * 0.05;
          ctx.fillStyle = color; ctx.fillText(ln, 0, y);
        }
      });
      ctx.restore();
    }

    snapshotFrame(t, w = 160) {
      // cheap thumbnail of the current canvas (for UI use)
      const c = document.createElement('canvas');
      c.width = w; c.height = Math.round(w * this.canvas.height / this.canvas.width);
      c.getContext('2d').drawImage(this.canvas, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    }

    /* --------------------------------------------------------- exporting */
    static pickMime() {
      const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      for (const m of list) if (global.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
      return '';
    }

    async export({ fps = 30, bitrate = 8e6, onProgress } = {}) {
      if (!global.MediaRecorder) throw new Error('Your browser cannot record video. Try Chrome, Edge or Firefox.');
      if (!this.project.clips.length) throw new Error('Add at least one clip first.');
      this.pause();
      this.ensureAudio();
      if (this.audio && this.audio.ctx.state === 'suspended') await this.audio.ctx.resume();
      await this._preload();
      this.seek(0);
      await new Promise((r) => setTimeout(r, 250));
      const stream = this.canvas.captureStream(fps);
      if (this.audio) this.audio.rec.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      const mimeType = Engine.pickMime();
      const rec = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: bitrate });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const done = new Promise((resolve) => { rec.onstop = resolve; });
      let cancelled = false;
      this._cancelExport = () => { cancelled = true; this.pause(); };
      const onTime = (t) => onProgress && onProgress(Math.min(1, t / this.total));
      this.on('time', onTime);
      rec.start(250);
      this.exporting = true;
      this.play();
      await new Promise((resolve) => {
        const check = () => (!this.playing ? resolve() : setTimeout(check, 100));
        check();
      });
      await new Promise((r) => setTimeout(r, 200));
      rec.stop();
      await done;
      this.exporting = false;
      this.listeners.time = this.listeners.time.filter((f) => f !== onTime);
      stream.getVideoTracks().forEach((t) => t.stop());
      if (cancelled) return null;
      const type = (mimeType || 'video/webm').split(';')[0];
      return new Blob(chunks, { type });
    }
    cancelExport() { if (this._cancelExport) this._cancelExport(); }

    _preload() {
      const waits = [];
      for (const v of this.clipEls.values()) if (v.readyState < 3) waits.push(new Promise((r) => { v.addEventListener('canplay', r, { once: true }); setTimeout(r, 6000); }));
      for (const c of this.project.clips) if (c.kind === 'image') { const img = this._imageFor(c.src); if (!img.complete) waits.push(new Promise((r) => { img.addEventListener('load', r, { once: true }); setTimeout(r, 6000); })); }
      return Promise.all(waits);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function isLight(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return true;
    const n = parseInt(m[1], 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 150;
  }

  global.ReelEngine = { Engine, ASPECTS, FILTERS, TRANSITIONS, MOTIONS, TEXT_STYLES, TEXT_ANIMS, BACKGROUNDS, TD };
})(window);
