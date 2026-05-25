# Architypes — Hugo theme

## Features

- **Immersive grid home page** with infinite scroll
- **Popover article view** with zoom-from-origin animation
- **Keyboard navigation** (`←`/`→` or `j`/`k`) and **swipe navigation** on mobile
- **Glass-styled** floating header (home + nav)
- **Light / dark themes** via `prefers-color-scheme`
- **Responsive images** with four-size srcsets, generated at build time from page-bundle resources
- **French-first** copy and locale defaults, but works in any language
- **Custom Forma Mono** typeface (variable, woff2)
- **24 posts per page**

## Requirements

- Hugo Extended v0.146.0+ (uses the new template system)

## Installation

This theme lives in `themes/architypes/` and is loaded via `hugo.toml`:

```toml
theme = "architypes"
```

To use it as a Hugo Module or git submodule, point at this repository the usual way:

```bash
# As a git submodule
git submodule add https://github.com/<you>/architypes-hugo.git themes/architypes
```

## Site configuration

A minimal `hugo.toml`:

```toml
baseURL = "https://example.com/"
languageCode = "fr-FR"
defaultContentLanguage = "fr"
title = "Architypes"
theme = "architypes"

[pagination]
  pagerSize = 24

[params]
  author = "Your Name"
  contactEmail = "you@example.com"
  mainSections = ["posts"]

[markup.goldmark.renderer]
  unsafe = true

[taxonomies]
  tag = "tags"

[permalinks.term]
  tags = "/tag/:slug/"

[imaging]
  quality = 85
  resampleFilter = "Lanczos"
```

## Content model

### Posts

Each post is a page bundle under `content/posts/<slug>/` with:

- `index.md` — front-matter + body
- `feature.jpg` (or `.png`, `.webp`…) — the feature image, automatically detected and resized to 300, 750, 1140 and 1920 px.

Example `index.md`:

```yaml
---
title: "Un exemple d'architype"
date: 2026-05-25T10:00:00+02:00
draft: false
tags:
  - paris-fr
featured: false
feature_image_alt: ""
feature_image_caption: "Façade en béton brut, lumière du matin."
---

Your Markdown here…
```

`feature_image_alt` and `feature_image_caption` are
both optional.

### About page

A single page at `content/about/index.md`:

```yaml
---
title: "À propos"
type: about
layout: single
url: /about/
---

Your bio…
```

The `type: about` triggers the dedicated template that opens in the popover when visited directly.

## Customisation hooks

Two empty partials let you inject site-specific markup without
forking the theme:

- `layouts/partials/head-extra.html` — extra `<head>` content (analytics, meta tags, favicons).
- `layouts/partials/foot-extra.html` — extra pre-`</body>` content.

Override either by creating the same file under `layouts/partials/` in your site root.

## License

EUPL v1.2
