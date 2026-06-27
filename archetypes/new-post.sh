#!/usr/bin/env bash
#
# new-post.sh — create a new Architypes post.
#
# Asks for a title and a date, then creates
#   content/posts/YYYYMMDD_<slug>/index.md
# pre-filled with the right front matter.
#
# Usage: ./archetypes/new-post.sh   (run with bash, not sh)

# This script relies on bash features (arrays, [[ ]]). If it was started with
# sh/dash/zsh, re-exec it under bash so `sh new-post.sh` still works.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# Resolve the project root (this script lives in <root>/archetypes).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
POSTS_DIR="$ROOT_DIR/content/posts"
DE_DIR="$ROOT_DIR/content/de"

# Turn a title into a slug: drop accents, lower-case, hyphenate.
slugify() {
  printf '%s' "$1" \
    | perl -CSD -MUnicode::Normalize -pe '$_=NFKD($_); s/\p{M}//g' \
    | perl -CSD -pe 'tr/A-Z/a-z/; s/['"'"'\x{2019}]//g; s/[^a-z0-9]+/-/g; s/^-+|-+$//g'
}

# Turn a 2-letter country code into its flag emoji (e.g. fr -> 🇫🇷).
flag_for() {
  perl -CS -e 'my($a,$b)=split//,lc(shift); print chr(0x1F1E6+ord($a)-ord("a")),chr(0x1F1E6+ord($b)-ord("a"))' "$1"
}

# Read a term's display title from its _index.md (front matter "title:").
term_title() {
  perl -CSD -ne 'if (/^title:\s*"?(.*?)"?\s*$/) { print $1; exit }' "$DE_DIR/$1/_index.md" 2>/dev/null
}

# --- Title -------------------------------------------------------------------
read -r -p "Title (e.g. À la belle fermière (Paris)): " TITLE
TITLE="${TITLE#"${TITLE%%[![:space:]]*}"}"   # trim leading space
TITLE="${TITLE%"${TITLE##*[![:space:]]}"}"   # trim trailing space
if [ -z "$TITLE" ]; then
  echo "Error: a title is required." >&2
  exit 1
fi

# --- Date --------------------------------------------------------------------
read -r -p "Date [YYYY-MM-DD, optionally + HH:MM] (default: today 15:00): " DATE_IN
DATE_IN="${DATE_IN// /}"
if [ -z "$DATE_IN" ]; then
  DATE_IN="$(date +%Y-%m-%d)"
fi

# Accept "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".
if [[ "$DATE_IN" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]]; then
  YMD="${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
  STAMP="${DATE_IN}T15:00:00Z"
elif [[ "$DATE_IN" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$ ]]; then
  YMD="${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
  STAMP="${DATE_IN}:00Z"
else
  echo "Error: date must look like 2026-06-27 or 2026-06-27T15:00." >&2
  exit 1
fi

# --- Location (the "de" taxonomy term) --------------------------------------
# List existing terms (folders under content/de) and let the user pick one,
# create a new one, or skip.
TERMS=()
if [ -d "$DE_DIR" ]; then
  for d in "$DE_DIR"/*/; do
    [ -d "$d" ] || continue          # no match -> skip the literal glob
    TERMS+=("$(basename "$d")")       # globs expand alphabetically
  done
fi

echo
echo "Location:"
for i in "${!TERMS[@]}"; do
  printf "  %2d) %-32s %s\n" "$((i + 1))" "${TERMS[$i]}" "$(term_title "${TERMS[$i]}")"
done
echo "   n) create a new location"
echo "   (leave empty for none)"

DE=""
while true; do
  read -r -p "Choose [number / n / empty]: " CHOICE
  CHOICE="${CHOICE// /}"
  if [ -z "$CHOICE" ]; then
    break
  elif [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "${#TERMS[@]}" ]; then
    DE="${TERMS[$((CHOICE - 1))]}"
    break
  elif [ "$CHOICE" = "n" ] || [ "$CHOICE" = "N" ]; then
    read -r -p "  City name (e.g. Lyon): " CITY
    CITY="${CITY#"${CITY%%[![:space:]]*}"}"; CITY="${CITY%"${CITY##*[![:space:]]}"}"
    read -r -p "  Country code, 2 letters (e.g. fr): " CC
    CC="$(printf '%s' "${CC// /}" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$CITY" ] || ! [[ "$CC" =~ ^[a-z]{2}$ ]]; then
      echo "  Need a city name and a 2-letter country code; try again." >&2
      continue
    fi
    DE="$(slugify "$CITY")-${CC}"
    TERM_DIR="$DE_DIR/$DE"
    if [ -d "$TERM_DIR" ]; then
      echo "  Location ${DE} already exists; using it."
    else
      mkdir -p "$TERM_DIR"
      printf -- '---\ntitle: "%s %s"\n---\n' "$CITY" "$(flag_for "$CC")" > "$TERM_DIR/_index.md"
      echo "  Created content/de/${DE}/_index.md"
    fi
    break
  else
    echo "  Invalid choice." >&2
  fi
done

# --- Slug --------------------------------------------------------------------
SUGGESTED_SLUG="$(slugify "$TITLE")"
read -r -p "Slug [${SUGGESTED_SLUG}]: " SLUG
SLUG="${SLUG// /}"
SLUG="${SLUG:-$SUGGESTED_SLUG}"
if [ -z "$SLUG" ]; then
  echo "Error: could not derive a slug; please provide one." >&2
  exit 1
fi

# --- Create the post ---------------------------------------------------------
DIR="$POSTS_DIR/${YMD}_${SLUG}"
if [ -e "$DIR" ]; then
  echo "Error: $DIR already exists." >&2
  exit 1
fi

mkdir -p "$DIR"

{
  echo "---"
  echo "title: \"${TITLE}\""
  echo "date: ${STAMP}"
  if [ -n "$DE" ]; then
    echo "de:"
    echo "  - \"${DE}\""
  fi
  echo "slug: \"${SLUG}\""
  echo "---"
  echo
} > "$DIR/index.md"

echo "Created ${DIR#"$ROOT_DIR/"}/index.md"
echo "Drop the photo in that folder (e.g. feature.jpg) and write the post."
