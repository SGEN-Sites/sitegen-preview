# sitegen-preview

Preview builds of SiteGen client sites. Every published page carries
`<meta name="robots" content="noindex, nofollow">`, so nothing here is indexed.
Everything else on the page — title, description, canonical, Open Graph, hreflang,
JSON-LD — is left as built, so scanners and audits read the real SEO data.

## Layout

- `main` holds only the tooling: this README, `tools/assemble.mjs` and the Pages workflow.
- Each client has its own branch, `client/<slug>`, holding that site's static files at the
  branch root, plus an optional `preview.json`:

  ```json
  { "name": "Alpine Vision", "template": "urbanoptics", "site": "https://alpinevision.com" }
  ```

- A version is a tag on that branch: `<slug>-v1`, `<slug>-v2`, … Untagged commits are not
  published.

## Published site

| Path | Content |
|---|---|
| `/` | master page: every client, its template, its live site, every version |
| `/<slug>/latest/` | the highest version |
| `/<slug>/v<N>/` | that version, kept for good |
| `/<slug>/v<N>/seo.json` | each page's SEO fields as built (robots shows the built value) |
| `/versions.json` | every client and version, for tooling |

There is no robots.txt Disallow on purpose: a crawler blocked from a page never sees its
noindex, and an audit tool that honours robots.txt would see nothing.

## Publishing a version

```sh
git switch --orphan client/<slug>      # first version only
# copy the site's files in, add preview.json
git add -A && git commit -m "<slug> v1"
git tag <slug>-v1
git push origin client/<slug> <slug>-v1
```

The tag push asks the workflow to rebuild from main; the site updates in a minute or two.

## Local build

```sh
node tools/assemble.mjs _site
```
