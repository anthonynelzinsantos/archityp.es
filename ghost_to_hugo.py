#!/usr/bin/env python3
"""
Ghost → Hugo importer for Architypes.

Reads a Ghost JSON export and produces a content/ tree suitable for the
Architypes Hugo theme. Each Ghost post becomes a page bundle:

    content/posts/<slug>/
    ├── index.md           ← front-matter + Pandoc-converted Markdown body
    └── feature.jpg        ← (you drop this in yourself)

The single Ghost "page" (the about page) is routed to:

    content/about/index.md

Tags are preserved by visible name (with emoji) in the front-matter, but
the URL uses the Ghost slug (e.g. /tag/paris-fr/).

Scheduled posts (future publication date) are imported with draft: true.
Published posts get draft: false.

Each index.md ends with an HTML comment recording the original Ghost
feature_image path so you can match images to bundles when dropping
them in:

    <!-- ghost-feature: /content/images/2025/05/foo-scaled.jpg -->

Usage:
    python3 ghost_to_hugo.py <ghost-export.json> <content-output-dir>

Example:
    python3 ghost_to_hugo.py \\
        architypes_ghost_2026-05-25-08-13-15.json \\
        ./content
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


# ──────────────────────────────────────────────────────────── helpers


def parse_ghost_date(s: str) -> datetime:
    """Ghost dates are ISO-8601 in UTC, e.g. '2025-04-24T06:46:38.000Z'."""
    # Python's fromisoformat doesn't accept 'Z' before 3.11, so normalise.
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def to_hugo_date(dt: datetime) -> str:
    """Hugo accepts RFC 3339; we keep UTC offset for round-trip safety."""
    return dt.isoformat().replace("+00:00", "Z")


def strip_ghost_url(html: str) -> str:
    """Replace Ghost's placeholder __GHOST_URL__ with a relative empty prefix.

    Ghost uses __GHOST_URL__ as a stand-in for the site URL in internal
    links and image src attributes during export. For a Hugo port we want
    these to become root-relative (or removed for content/ image refs).
    """
    if not html:
        return html
    # __GHOST_URL__/content/images/... → /images/... is wrong for Hugo
    # because page-bundle images live alongside index.md. We leave the
    # path as-is and just drop the placeholder so the URL becomes
    # /content/images/... — that way it's obvious in the output that
    # these links still need attention.
    return html.replace("__GHOST_URL__", "")


def yaml_escape(s: str) -> str:
    """Wrap a string for YAML, escaping double quotes and backslashes.

    Used for title/alt/caption fields. We always emit double-quoted
    strings to dodge the YAML escape-character minefield.
    """
    if s is None:
        return '""'
    # Escape backslashes first, then double quotes
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    # Strip CR/LF — YAML scalars in single-line quoted form can't contain
    # raw newlines. None of our fields legitimately need them.
    s = s.replace("\r", " ").replace("\n", " ").strip()
    return f'"{s}"'


def html_to_markdown(html: str) -> str:
    """Pipe HTML through Pandoc → CommonMark + GFM extensions.

    Chosen flags:
      --from html-native_divs-native_spans
                               drop <div>/<span> wrappers Pandoc would
                               otherwise preserve verbatim (Ghost editor
                               often emits decorative ones)
      --to commonmark_x-attributes
                               CommonMark with GFM extensions but no
                               {.class #id} attribute syntax in output
      --wrap=none              never hard-wrap; let editors handle that
      --markdown-headings=atx  use # / ## headings, not Setext underline
    """
    if not html.strip():
        return ""
    proc = subprocess.run(
        [
            "pandoc",
            "--from=html-native_divs-native_spans",
            "--to=commonmark_x-attributes",
            "--wrap=none",
            "--markdown-headings=atx",
        ],
        input=html,
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


_STYLE_SPAN_RE = re.compile(r'<span style="[^"]*">(.*?)</span>', re.DOTALL)


def clean_caption(s: str | None) -> str | None:
    """Strip Ghost editor cruft from feature_image_caption.

    Ghost's caption field is rich-text; the editor often wraps plain text
    in <span style="white-space: pre-wrap;">…</span>. Hugo will render
    captions inside <figcaption>, where that span is pointless noise.
    """
    if not s:
        return s
    cleaned = s
    # Repeat to peel nested spans
    for _ in range(3):
        new = _STYLE_SPAN_RE.sub(r"\1", cleaned)
        if new == cleaned:
            break
        cleaned = new
    return cleaned.strip()


def feature_image_basename(ghost_url: str) -> str:
    """Pull just the basename out of a Ghost feature_image URL.

    '__GHOST_URL__/content/images/2025/05/foo-scaled.jpg' → 'foo-scaled.jpg'
    """
    return ghost_url.rsplit("/", 1)[-1] if ghost_url else ""


def feature_image_ext(ghost_url: str) -> str:
    """Lowercase extension (with leading dot) or '.jpg' as a sensible default."""
    if not ghost_url:
        return ".jpg"
    return os.path.splitext(ghost_url)[1].lower() or ".jpg"


# ─────────────────────────────────────────────────── front-matter builder


def build_frontmatter(
    *,
    title: str,
    date: datetime,
    draft: bool,
    tags: list[str],
    featured: bool,
    feature_image_alt: str | None,
    feature_image_caption: str | None,
    is_about: bool,
) -> str:
    """Emit YAML front-matter that matches what the Architypes theme expects.

    The about page gets a different shape (type/layout/url instead of tags).
    """
    lines = ["---"]
    lines.append(f"title: {yaml_escape(title)}")
    lines.append(f"date: {to_hugo_date(date)}")
    lines.append(f"draft: {'true' if draft else 'false'}")

    if is_about:
        lines.append("type: about")
        lines.append("layout: single")
        lines.append("url: /about/")
    else:
        if tags:
            lines.append("tags:")
            for t in tags:
                lines.append(f"  - {yaml_escape(t)}")
        else:
            lines.append("tags: []")
        lines.append(f"featured: {'true' if featured else 'false'}")
        # Always emit alt/caption keys (even when empty) so they're
        # discoverable when you edit posts later.
        lines.append(f"feature_image_alt: {yaml_escape(feature_image_alt or '')}")
        lines.append(
            f"feature_image_caption: {yaml_escape(feature_image_caption or '')}"
        )

    lines.append("---")
    return "\n".join(lines)


# ──────────────────────────────────────────────────────────── main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("export", type=Path, help="Path to Ghost JSON export")
    parser.add_argument(
        "output",
        type=Path,
        help="Path to the Hugo site's content/ directory (will be created)",
    )
    parser.add_argument(
        "--include-scheduled",
        action="store_true",
        default=True,
        help="Import scheduled posts as drafts (default: yes)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be written without touching disk",
    )
    args = parser.parse_args()

    if not args.export.is_file():
        print(f"error: {args.export} does not exist", file=sys.stderr)
        return 1

    with args.export.open(encoding="utf-8") as f:
        data = json.load(f)

    db = data["db"][0]["data"]
    posts = db["posts"]
    tags_by_id = {t["id"]: t for t in db["tags"]}
    posts_meta_by_post = {m["post_id"]: m for m in db["posts_meta"]}

    # Build post_id → [tag_id, ...]
    tags_per_post: dict[str, list[str]] = defaultdict(list)
    for pt in db["posts_tags"]:
        tags_per_post[pt["post_id"]].append(pt["tag_id"])

    posts_dir = args.output / "posts"
    about_dir = args.output / "about"
    tags_dir = args.output / "tags"

    stats = {"posts": 0, "about": 0, "drafts": 0, "skipped": 0, "tags": 0}
    feature_mapping: list[tuple[str, str, str]] = []  # (bundle, original_basename, slug)

    for p in posts:
        # ----- decide where this goes -----
        if p["type"] == "page" and p["slug"] == "about":
            target_dir = about_dir
            is_about = True
        elif p["type"] == "post":
            target_dir = posts_dir / p["slug"]
            is_about = False
        else:
            # Unhandled type: surface it rather than silently dropping
            print(
                f"  skipping {p['slug']!r} (type={p['type']}, not handled)",
                file=sys.stderr,
            )
            stats["skipped"] += 1
            continue

        # ----- draft? scheduled? skip? -----
        status = p.get("status", "")
        if status == "scheduled":
            if not args.include_scheduled:
                stats["skipped"] += 1
                continue
            draft = True
            stats["drafts"] += 1
        elif status == "published":
            draft = False
        else:
            print(
                f"  skipping {p['slug']!r} (status={status!r}, not published/scheduled)",
                file=sys.stderr,
            )
            stats["skipped"] += 1
            continue

        # ----- tags -----
        # In post front-matter we use the SLUG (Ghost's ascii slug like
        # "paris-fr"), not the visible name with emoji. Hugo derives the
        # tag URL from the value in front-matter; using the slug gives
        # us the Ghost-compatible /tag/paris-fr/ URL.
        #
        # The visible name with emoji is set on the term page via
        # tags/<slug>/_index.md (written further down), where Hugo will
        # use its title: as the display name in the header chip etc.
        tag_slugs: list[str] = []
        for tid in tags_per_post.get(p["id"], []):
            t = tags_by_id.get(tid)
            if t and t.get("visibility", "public") == "public":
                tag_slugs.append(t["slug"])

        # ----- metadata -----
        meta = posts_meta_by_post.get(p["id"], {})
        feature_image_alt = meta.get("feature_image_alt")
        feature_image_caption = clean_caption(meta.get("feature_image_caption"))

        # ----- date -----
        # Prefer published_at; fall back to updated_at then created_at
        date_str = p.get("published_at") or p.get("updated_at") or p.get("created_at")
        if not date_str:
            print(f"  warning: no date on {p['slug']!r}, using epoch", file=sys.stderr)
            date = datetime(1970, 1, 1, tzinfo=timezone.utc)
        else:
            date = parse_ghost_date(date_str)

        # ----- convert body -----
        html = strip_ghost_url(p.get("html") or "")
        body_md = html_to_markdown(html)

        # ----- front-matter -----
        fm = build_frontmatter(
            title=p["title"],
            date=date,
            draft=draft,
            tags=tag_slugs,
            featured=bool(p.get("featured")),
            feature_image_alt=feature_image_alt,
            feature_image_caption=feature_image_caption,
            is_about=is_about,
        )

        # ----- assemble the file -----
        ghost_fi = p.get("feature_image") or ""
        fi_basename = feature_image_basename(strip_ghost_url(ghost_fi))
        fi_ext = feature_image_ext(ghost_fi)

        # Footer comment helps you (a) match the Ghost image to the new
        # bundle, and (b) know what extension to save the local file as.
        footer = (
            f"\n\n<!-- ghost-feature: {strip_ghost_url(ghost_fi)} -->\n"
            f"<!-- expected local filename: feature{fi_ext} -->\n"
        )

        contents = f"{fm}\n\n{body_md}{footer}"

        # ----- write -----
        if args.dry_run:
            print(f"  would write {target_dir / 'index.md'}  ({len(contents)} bytes)")
        else:
            target_dir.mkdir(parents=True, exist_ok=True)
            (target_dir / "index.md").write_text(contents, encoding="utf-8")

        if is_about:
            stats["about"] += 1
        else:
            stats["posts"] += 1

        if not is_about:
            feature_mapping.append(
                (str(target_dir.relative_to(args.output)), fi_basename, p["slug"])
            )

    # ----- write the feature-image map -----
    if not args.dry_run and feature_mapping:
        map_path = args.output / "_ghost-feature-images.csv"
        with map_path.open("w", encoding="utf-8") as f:
            f.write("bundle,original_ghost_filename,slug\n")
            for bundle, basename, slug in sorted(feature_mapping):
                f.write(f"{bundle},{basename},{slug}\n")
        print(f"\nWrote feature-image mapping → {map_path}")

    # ----- write tag _index.md files to set the display name -----
    # The directory name (Ghost's slug, e.g. paris-fr) IS the URL slug.
    # The title: field sets the display name (e.g. "Paris 🇫🇷") that the
    # theme uses in the header chip and <h1>. Posts reference tags by
    # slug in their front-matter (see above).
    used_tag_ids = {tid for tids in tags_per_post.values() for tid in tids}
    for tid in used_tag_ids:
        t = tags_by_id.get(tid)
        if not t or t.get("visibility") != "public":
            continue
        tag_dir = tags_dir / t["slug"]
        fm_lines = [
            "---",
            f"title: {yaml_escape(t['name'])}",
            "---",
            "",
        ]
        if args.dry_run:
            print(f"  would write {tag_dir / '_index.md'}")
        else:
            tag_dir.mkdir(parents=True, exist_ok=True)
            (tag_dir / "_index.md").write_text("\n".join(fm_lines), encoding="utf-8")
        stats["tags"] += 1

    # ----- summary -----
    print()
    print(f"Imported: {stats['posts']} posts, {stats['about']} about page, "
          f"{stats['tags']} tag indexes")
    print(f"  of which drafts (scheduled): {stats['drafts']}")
    if stats["skipped"]:
        print(f"  skipped: {stats['skipped']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
