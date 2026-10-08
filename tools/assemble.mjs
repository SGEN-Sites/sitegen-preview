// Builds the preview site from the repository's version tags. No dependencies.
//
//   node tools/assemble.mjs [outDir]       (default _site)
//
// SOURCE. Each client lives on its own branch, `client/<slug>`, and every published version of it is
// a tag `<slug>-v<N>` on that branch. The tag is the version: a later commit on the branch is work in
// progress and is not published until it is tagged.
//
// OUTPUT.
//   <slug>/v<N>/...        the tagged files, every version kept
//   <slug>/latest/...      a copy of the highest version
//   <slug>/v<N>/seo.json   the SEO fields of every page AS BUILT, read before anything is changed
//   versions.json          every client and version, for the master page and for audit tooling
//   index.html             the master page
//
// NOT INDEXABLE, SEO DATA KEPT. Every published .html gets <meta name="robots" content="noindex,
// nofollow"> — an existing robots meta is rewritten, nothing else on the page is touched, so title,
// description, canonical, Open Graph, hreflang and JSON-LD are all still there for a scanner to read.
// There is deliberately no robots.txt Disallow: a crawler that may not fetch a page never sees its
// noindex, and an audit tool that honours robots.txt would see nothing at all. (A project site's
// robots.txt is not read by crawlers anyway — only the host root's is.)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || '_site');
// Each client's current live site, keyed by slug. A client branch's preview.json `site` wins.
const SITES = JSON.parse(fs.readFileSync(new URL('./sites.json', import.meta.url), 'utf8'));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 30 }).trim();

const NOINDEX = '<meta name="robots" content="noindex, nofollow">';

export function forceNoindex(html) {
  const s = String(html);
  const robots = /<meta\b[^>]*\bname\s*=\s*["']?robots["']?[^>]*>/gi;
  if (robots.test(s)) return s.replace(robots, NOINDEX);
  if (/<head\b[^>]*>/i.test(s)) return s.replace(/<head\b[^>]*>/i, (h) => `${h}\n${NOINDEX}`);
  return `${NOINDEX}\n${s}`;
}

const attr = (tag, name) => (new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag) || [])[2];
const text = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const metaBy = (html, key, val) => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if ((attr(m[0], key) || '').toLowerCase() === val) return attr(m[0], 'content') ?? null;
  return null;
};

export function seoOf(html) {
  const s = String(html);
  const body = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const ld = [...s.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const types = [];
  for (const m of ld) {
    try {
      const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n['@type']) types.push(n['@type']); if (n['@graph']) walk(n['@graph']); } };
      walk(JSON.parse(m[1]));
    } catch { types.push('(unparseable)'); }
  }
  const link = (rel) => { for (const m of s.matchAll(/<link\b[^>]*>/gi)) if ((attr(m[0], 'rel') || '').toLowerCase() === rel) return attr(m[0], 'href') ?? null; return null; };
  return {
    title: text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1] || '') || null,
    description: metaBy(s, 'name', 'description'),
    robots: metaBy(s, 'name', 'robots'),
    canonical: link('canonical'),
    h1: [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => text(m[1])),
    h2Count: (body.match(/<h2\b/gi) || []).length,
    og: { title: metaBy(s, 'property', 'og:title'), description: metaBy(s, 'property', 'og:description'), image: metaBy(s, 'property', 'og:image'), url: metaBy(s, 'property', 'og:url') },
    hreflang: [...s.matchAll(/<link\b[^>]*hreflang[^>]*>/gi)].map((m) => ({ lang: attr(m[0], 'hreflang'), href: attr(m[0], 'href') })),
    jsonLd: types,
    lang: attr((/<html\b[^>]*>/i.exec(s) || [''])[0], 'lang') ?? null,
    images: (body.match(/<img\b/gi) || []).length,
    imagesNoAlt: [...body.matchAll(/<img\b[^>]*>/gi)].filter((m) => attr(m[0], 'alt') === undefined).length,
    words: text(body.replace(/<head[\s\S]*?<\/head>/i, '')).split(' ').filter(Boolean).length,
  };
}

function walkFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function exportTag(tag, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const files = git('ls-tree', '-r', '--name-only', tag).split('\n').filter(Boolean);
  const pages = [];
  for (const f of files) {
    const buf = execFileSync('git', ['show', `${tag}:${f}`], { maxBuffer: 1 << 30 });
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (/\.html?$/i.test(f)) {
      const html = buf.toString('utf8');
      pages.push({ path: f, ...seoOf(html) });
      fs.writeFileSync(to, forceNoindex(html));
    } else fs.writeFileSync(to, buf);
  }
  return { files: files.length, pages };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The master page, in the SGEN artifact house format. tools/house.html is a copy of
// .claude/skills/sgen-artifact-format/template.html from the SGEN repo (the build runs on GitHub,
// where that folder does not exist); re-copy it when the house format changes. It is filled the
// way sgen-link-check fills it: h2/h3 ids, the nav's data-target links and the RAIL map in step.
function masterPage(clients, built) {
  const tag = (cls, t) => `<span class="tag ${cls}">${esc(t)}</span>`;
  let n = 0;
  const h2 = (id, title) => `<h2 id="${id}"><span class="h-badge">${String(++n).padStart(2, '0')}</span><span class="h-text">${esc(title)}</span><a class="h-anchor" href="#${id}" aria-label="Link to this section">#</a></h2>`;
  const h3 = (id, title) => `<h3 id="${id}"><span class="h-text">${esc(title)}</span><a class="h-anchor" href="#${id}" aria-label="Link to this section">#</a></h3>`;
  const S = [];
  const add = (id, title, body, subs = []) => S.push({ id, title, html: h2(id, title) + body, subs });

  const row = (c) => {
    const last = c.versions.at(-1);
    return [
      `<strong>${esc(c.name || c.slug)}</strong><br><small><code>${esc(c.slug)}</code></small>`,
      c.site ? `<a href="${esc(c.site)}" rel="noopener nofollow">${esc(c.site.replace(/^https?:\/\//, ''))}</a>` : '<small>—</small>',
      `<a href="${esc(c.slug)}/latest/">Open v${last.n}</a>`,
      c.versions.slice().reverse().map((v) => `<a href="${esc(c.slug)}/v${v.n}/">v${v.n}</a> <small>${esc(v.date)} · ${v.pages} pages</small>`).join('<br>'),
    ];
  };
  const table = (rows) => `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Live site</th><th>Latest</th><th>Versions</th></tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  const byTpl = new Map();
  for (const c of clients) {
    const t = c.template || 'other';
    if (!byTpl.has(t)) byTpl.set(t, []);
    byTpl.get(t).push(c);
  }
  const groups = [...byTpl].sort(([a], [b]) => a.localeCompare(b));
  const slugId = (t) => `tpl-${String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  add('clients', 'Clients',
    clients.length
      ? groups.map(([t, cs]) => h3(slugId(t), `${t} (${cs.length})`) + table(cs.map(row))).join('')
      : `<p>${tag('t-mid', 'empty')} No client builds published yet.</p>`,
    groups.map(([t, cs]) => ({ id: slugId(t), text: `${t} (${cs.length})` })));

  add('seo', 'Indexing and SEO data',
    `<div class="legend">
      <div class="leg">${tag('t-no', 'noindex')}<small>Every published page carries <code>noindex, nofollow</code>. Search engines drop it; nothing here competes with a client's live site.</small></div>
      <div class="leg">${tag('t-ok', 'kept')}<small>Title, description, canonical, Open Graph, hreflang and JSON-LD are left exactly as built, so scanners and audits read real values.</small></div>
      <div class="leg">${tag('t-mid', 'as built')}<small><code>seo.json</code> records each page's robots value from before the noindex was added.</small></div>
    </div>
    <p>There is no robots.txt block. A crawler that may not fetch a page never sees its noindex, and an audit tool that obeys robots.txt would see nothing. <a href="versions.json">versions.json</a> lists every client and version for tooling.</p>`);

  add('versions', 'How versions work',
    `<p>Each client has a branch, <code>client/&lt;slug&gt;</code>. A version is a tag on it, <code>&lt;slug&gt;-v1</code>, <code>&lt;slug&gt;-v2</code>, and every version stays published at <code>/&lt;slug&gt;/v&lt;N&gt;/</code>. <code>/&lt;slug&gt;/latest/</code> is the highest one. Commits without a tag are not published.</p>`);

  const pages = clients.reduce((t, c) => t + c.versions.reduce((u, v) => u + v.pages, 0), 0);
  const nav = `<div class="nav-group"><div class="nav-label">Previews</div><ul>${S.map((s, i) =>
    `<li><a href="#${s.id}" data-target="${s.id}"><span class="n-badge">${String(i + 1).padStart(2, '0')}</span><span class="n-text">${esc(s.title)}</span></a></li>`).join('')}</ul></div>`;
  const art = `<h1 id="doc-title"><span class="h-text">SiteGen previews</span><a class="h-anchor" href="#doc-title" aria-label="Link to this section">#</a></h1>
    <p>${clients.length} client site${clients.length === 1 ? '' : 's'} built by SiteGen, ${pages} pages across every version. Previews for review only: none of these pages is indexed.</p>
    ${S.map((s) => s.html).join('\n')}
    <div class="foot">sitegen-preview · assembled from the repository's version tags · ${esc(built)} UTC · preview builds, not live sites</div>`;
  const rail = Object.fromEntries(S.filter((s) => s.subs.length).map((s) => [s.id, s.subs]));

  let t = fs.readFileSync(new URL('./house.html', import.meta.url), 'utf8');
  const swap = (re, val) => { if (!re.test(t)) throw new Error(`master page: house template anchor not found: ${re}`); t = t.replace(re, () => val); };
  swap(/<title>[\s\S]*?<\/title>/, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${NOINDEX}\n<title>SGEN — SiteGen previews</title>`);
  swap(/<meta name="description" content="[^"]*">/, `<meta name="description" content="SiteGen client site previews: every client, template and version. Not indexed.">`);
  swap(/<\/style>/, '</style>\n</head><body>');
  swap(/<div class="doctitle">[\s\S]*?<\/div>/, '<div class="doctitle">SiteGen previews</div>');
  swap(/<span class="chip live">[\s\S]*?<\/span>/, `<span class="chip live">${clients.length} clients · noindex</span>`);
  swap(/<div class="nav-group">[\s\S]*?<\/ul><\/div>/, nav);
  swap(/(<main class="art">)[\s\S]*?(<\/main>)/, `<main class="art">\n${art}\n</main>`);
  swap(/var RAIL=\{\};/, `var RAIL=${JSON.stringify(rail).replace(/</g, '\\u003c')};`);
  return `${t.trimEnd()}\n</body></html>\n`;
}

export function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tags = git('tag', '--list').split('\n').filter(Boolean);
  const bySlug = new Map();
  for (const t of tags) {
    const m = /^(.+)-v(\d+)$/.exec(t);
    if (!m) continue;
    if (!bySlug.has(m[1])) bySlug.set(m[1], []);
    bySlug.get(m[1]).push({ n: Number(m[2]), tag: t });
  }
  const clients = [];
  for (const [slug, vs] of [...bySlug].sort(([a], [b]) => a.localeCompare(b))) {
    vs.sort((a, b) => a.n - b.n);
    const versions = [];
    let meta = {};
    for (const v of vs) {
      const dir = path.join(OUT, slug, `v${v.n}`);
      const r = exportTag(v.tag, dir);
      const date = git('log', '-1', '--format=%cs', v.tag);
      const commit = git('rev-list', '-n', '1', v.tag);
      try { meta = JSON.parse(git('show', `${v.tag}:preview.json`)); } catch { /* optional */ }
      fs.writeFileSync(path.join(dir, 'seo.json'), `${JSON.stringify({ client: slug, version: v.n, tag: v.tag, commit, date, note: 'robots is the value AS BUILT; the published copy is noindex, nofollow', pages: r.pages }, null, 1)}\n`);
      versions.push({ n: v.n, tag: v.tag, commit, date, files: r.files, pages: r.pages.length });
    }
    fs.cpSync(path.join(OUT, slug, `v${versions.at(-1).n}`), path.join(OUT, slug, 'latest'), { recursive: true });
    clients.push({ slug, name: meta.name, template: meta.template, site: meta.site || SITES[slug], versions });
  }
  const built = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(OUT, 'versions.json'), `${JSON.stringify({ built, clients }, null, 1)}\n`);
  fs.writeFileSync(path.join(OUT, 'index.html'), masterPage(clients, built));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  const html = walkFiles(OUT).filter((f) => /\.html?$/i.test(f));
  const leaked = html.filter((f) => !fs.readFileSync(path.join(OUT, f), 'utf8').includes(NOINDEX));
  if (leaked.length) throw new Error(`pages without noindex: ${leaked.slice(0, 5).join(', ')}`);
  console.log(`assembled ${clients.length} clients, ${html.length} html pages, all noindex -> ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}` || process.argv[1].endsWith('assemble.mjs')) main();
