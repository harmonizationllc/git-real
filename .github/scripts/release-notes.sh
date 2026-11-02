#!/usr/bin/env bash
# Extract one version's release notes from CHANGELOG.md (GR-38).
#
# Usage: release-notes.sh <version> <changelog-path>
#
# Hand-written notes replace GitHub's generated notes. The script prints the body
# of the "## <version>" section to stdout: no heading, no leading or trailing
# blank lines, every other line verbatim. The heading is matched as a whole line
# by string comparison, never by prefix or regex, so "0.1.0" does not match
# "## 0.1.0-rc1" and the dots in a version are literal.
# A body line beginning with "## " ends the section, fences included. With
# duplicate headings the first wins. A heading with trailing whitespace does not
# match (Prettier removes it before it reaches CI).
#
# Exit 1 when the section is missing or has no non-blank line. Exit 2 on a bad
# call or an unreadable changelog.
set -euo pipefail

usage="usage: release-notes.sh <version> <changelog-path>"

if [ "$#" -ne 2 ]; then
  echo "$usage" >&2
  exit 2
fi

version="$1"
changelog="$2"

if [ ! -f "$changelog" ] || [ ! -r "$changelog" ]; then
  echo "$usage" >&2
  echo "release-notes: cannot read $changelog" >&2
  exit 2
fi

# The version goes through the environment: awk -v would process backslash escapes.
# The awk program prints "FOUND" first when the heading exists, then the section
# body with leading and trailing blank lines dropped.
out="$(
  NOTES_VERSION="$version" awk '
    BEGIN { want = "## " ENVIRON["NOTES_VERSION"] }
    {
      line = $0
      sub(/\r$/, "", line)
    }
    inside && line ~ /^## / { inside = 0 }
    !inside && !found && line == want { inside = 1; found = 1; print "FOUND"; next }
    inside {
      if (line ~ /^[ \t]*$/) { held = held line "\n"; next }
      if (started) { printf "%s", held }
      held = ""
      started = 1
      print line
    }
  ' "$changelog"
)"

if [ -z "$out" ]; then
  echo "release-notes: no section \"## $version\" in $changelog" >&2
  exit 1
fi

notes="${out#FOUND}"
notes="${notes#$'\n'}"
if [ -z "$notes" ]; then
  echo "release-notes: section \"## $version\" in $changelog is empty" >&2
  exit 1
fi
printf '%s\n' "$notes"
