// Test support: read the declarations that apply to a CSS-module class from raw CSS text.
// Handles grouped selectors (`.a, .root`) and pseudo/attribute suffixes (`.root:hover`), which
// a single-selector regex misses. Rules nested in an at-rule (`@media`, `@supports`) are read
// as if top-level, without their condition.

/**
 * The concatenated declaration blocks of every top-level rule whose comma-separated selector
 * list contains a selector naming `className` as a class token. Comments are stripped first.
 */
export function declarationsOf(css: string, className: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const token = new RegExp(`\\.${className}(?![\\w-])`);
  const blocks: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map((s) => s.trim());
    if (selectors.some((s) => token.test(s))) blocks.push(match[2]!.trim());
  }
  return blocks.join("\n");
}
