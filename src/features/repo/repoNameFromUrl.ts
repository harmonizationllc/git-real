const SCHEME_AND_HOST = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

/** Derives a default folder name from a clone URL, or null when none can be found. */
export function repoNameFromUrl(url: string): string | null {
  const withoutHost = url.trim().replace(SCHEME_AND_HOST, "");
  const trimmed = withoutHost.replace(/\/+$/, "");
  const tail = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":")) + 1);
  const name = tail.replace(/\.git$/, "");
  return name === "" ? null : name;
}
