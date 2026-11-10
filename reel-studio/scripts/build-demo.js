#!/usr/bin/env node
/*
 * build-demo.js — bundles the studio into ONE self-contained HTML page that runs
 * without the backend (api-local.js replaces api.js). Used to publish a demo link.
 *
 *   node scripts/build-demo.js [output.html]
 *
 * The output has no <html>/<head>/<body> wrapper, because the host that serves
 * the demo adds its own.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
const out = process.argv[2] || path.join(__dirname, '..', 'dist', 'reel-studio-demo.html');

const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src='));
const fonts = html.match(/<link href="https:\/\/fonts\.googleapis\.com[^>]+>/)[0];
const demoCss = `
/* demo build: fit inside the host page instead of the full viewport */
html, body { height: 100%; }
.app { height: 100%; }
.mobile-nav { padding-bottom: env(safe-area-inset-bottom, 0px); height: calc(60px + env(safe-area-inset-bottom, 0px)); }
.demo-note { font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--cyan); border: 1px solid rgba(34, 211, 238, .4); border-radius: 999px; padding: 3px 9px; white-space: nowrap; }
@media (max-width: 860px) { .demo-note { display: none; } }
`;
const scripts = ['js/ds.js', 'js/engine.js', 'js/api-local.js', 'js/app.js'].map((f) => `<script>\n${read(f).replace(/<\/script/g, '<\\/script')}\n</script>`).join('\n');
const page = [
  '<title>Reel Maker Studio</title>',
  fonts,
  `<style>\n${read('css/studio.css')}\n${demoCss}</style>`,
  body.replace('<span id="saveState"', '<span class="demo-note" title="Nothing is saved between visits and AI generation is off">Demo</span>\n        <span id="saveState"'),
  '<script>window.REEL_DEMO = true;</script>',
  scripts,
].join('\n');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
