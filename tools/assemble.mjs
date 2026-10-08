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

function masterPage(clients, built) {
  const rows = clients.map((c) => `
    <tr>
      <td><strong>${esc(c.name || c.slug)}</strong><br><span class="dim">${esc(c.slug)}</span></td>
      <td>${esc(c.template || '')}</td>
      <td>${c.site ? `<a href="${esc(c.site)}" rel="noopener nofollow">${esc(c.site.replace(/^https?:\/\//, ''))}</a>` : ''}</td>
      <td><a class="btn" href="${esc(c.slug)}/latest/">Open v${c.versions.at(-1).n}</a></td>
      <td>${c.versions.slice().reverse().map((v) => `<a href="${esc(c.slug)}/v${v.n}/">v${v.n}</a> <span class="dim">${esc(v.date)}</span> · <a class="dim" href="${esc(c.slug)}/v${v.n}/seo.json">seo</a>`).join('<br>')}</td>
    </tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
${NOINDEX}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SiteGen previews</title>
<style>
:root{--bg:#f7f7f5;--fg:#1b1d1f;--dim:#6b7075;--line:#e2e2de;--acc:#0b6bcb}
@media (prefers-color-scheme:dark){:root{--bg:#141618;--fg:#e8e9ea;--dim:#9aa0a6;--line:#2a2e32;--acc:#6aa9ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px}h1{margin:0 0 4px;font-size:24px}
p{margin:0 0 20px;color:var(--dim)}.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}
th,td{text-align:left;vertical-align:top;padding:12px 10px;border-bottom:1px solid var(--line)}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
a{color:var(--acc)}.dim{color:var(--dim);font-size:13px}.btn{display:inline-block;padding:6px 12px;border:1px solid var(--acc);border-radius:6px;text-decoration:none;white-space:nowrap}
</style></head><body><main>
<h1>SiteGen previews</h1>
<p>${clients.length} client${clients.length === 1 ? '' : 's'} · built ${esc(built)} · every page is noindex · versions.json lists every build</p>
${clients.length ? `<div class="wrap"><table><thead><tr><th>Client</th><th>Template</th><th>Live site</th><th>Latest</th><th>Versions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No client builds published yet.</p>'}
</main></body></html>
`;
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
    clients.push({ slug, name: meta.name, template: meta.template, site: meta.site, versions });
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
