# Architypes

Mémoires d'un passé (pas si) lointain.

## Content

- `content/posts/YYYYMMDD_slug/` — main content published every 3 days
  - `index.md` front matter: `title`, `date`, `de` (list of location slugs), `slug`
  - `feature.jpg`
- `content/de/<city-cc>/_index.md` — location taxonomy term (e.g. `lyon-fr`)
  - front matter `title: "City 🇫🇷"`
- `content/about`, `content/404` — static pages

## Publishing

`.github/workflows/publish.yml` builds with Hugo and deploys via FTP on push to `main`, and daily at 17:01 UTC. Hugo doesn’t build future-dated content by default, so the backlog is committed months ahead with future dates, and the daily rebuild reveals one post every 3 days on its own.

## Authoring

- `hugo server` — local preview
- `archetypes/new-post.sh` — interactive, one post at a time. Prompts for title/date/location/slug, creates the folder + `index.md`. Photo has to be dropped in by hand.
- `tools/batch-editor/` — local web UI for batch creation.
  - `node tools/batch-editor/server.js` → opens `http://127.0.0.1:4747`
  - drop exported photos in `_inbox/` (gitignored)
  - pick a photo, fill the form, submit — writes the post + moves the photo in as `feature.jpg`
  - date auto-advances by 3 days, location dropdown reuses/creates `de` terms, undo button for the last entry

## Config (`hugo.yaml`)

- French (`fr-FR`), taxonomy `de`
- permalinks: posts at `/:slug/`, posts list at `/`, `de` terms at `/de/:contentbasename/`
- pagination 24/page, images resized on build (Lanczos, quality 90)
