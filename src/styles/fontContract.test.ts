import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DIFF_SIZE_TOKEN, FONT_FAMILY_TOKENS, FONT_WEIGHTS, TEXT_SIZE_TOKENS } from "./fontTokens";

/**
 * Every distinct (family, size, weight) costs a cold fontconfig lookup in WebKitGTK, so the
 * stylesheets may only use the finite set of values below.
 */
const SRC = join(__dirname, "..");

const FAMILIES: readonly string[] = [...FONT_FAMILY_TOKENS.map((t) => `var(${t})`), "inherit"];
const SIZES: readonly string[] = [
  ...TEXT_SIZE_TOKENS.map((t) => `var(${t})`),
  `var(${DIFF_SIZE_TOKEN})`,
  "1em",
  "inherit",
];
const WEIGHTS: readonly string[] = [...FONT_WEIGHTS, "inherit"];
const SHORTHANDS: readonly string[] = ["inherit"];

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** Blanks comments but keeps newlines so reported line numbers stay true. */
export function stripComments(text: string, lineComments: boolean): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  // A `//` after a colon is a URL, not a comment.
  return lineComments
    ? noBlock.replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)))
    : noBlock;
}

export interface Declaration {
  line: number;
  prop: "font-family" | "font-size" | "font-weight" | "font";
  value: string;
}

const PROPS: Record<string, Declaration["prop"]> = {
  "font-family": "font-family",
  fontFamily: "font-family",
  "font-size": "font-size",
  fontSize: "font-size",
  "font-weight": "font-weight",
  fontWeight: "font-weight",
  font: "font",
};

const CSS_DECL = /(^|[^\w-])(font-family|font-size|font-weight|font)\s*:\s*([^;}\n]*)/g;
/** Font declarations inside template-literal CSS text; the shorthand is left to the key scan. */
const TEMPLATE_CSS_DECL = /(^|[^\w-])(font-family|font-size|font-weight)\s*:\s*([^;}\n`]*)/g;
/** Keys bare or quoted (`"font-family":`), with a quoted, template or numeric literal value. */
const TS_DECL =
  /(^|[^\w-])(["']?)(font-family|font-size|font-weight|fontFamily|fontSize|fontWeight|font)\2\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|(\d+(?:\.\d+)?)(?![\w.]))/g;

/**
 * Finds real font properties; custom properties like `--text-xs:` never match. In TS it also scans
 * the CSS text of template literals, keeping one entry per property position.
 */
export function scanDeclarations(text: string, ts: boolean): Declaration[] {
  const found = new Map<number, Declaration>();
  const add = (at: number, prop: string, raw: string) => {
    if (found.has(at)) return;
    const value = raw.trim().replace(/\s*!important$/, "");
    found.set(at, { line: text.slice(0, at).split("\n").length, prop: PROPS[prop], value });
  };
  if (!ts) {
    for (const m of text.matchAll(CSS_DECL)) add(m.index + m[1].length, m[2], m[3]);
  } else {
    for (const m of text.matchAll(TS_DECL)) {
      add(m.index + m[1].length + m[2].length, m[3], m[4] ?? m[5] ?? m[6] ?? m[7]);
    }
    for (const t of text.matchAll(/`[^`]*`/g)) {
      for (const m of t[0].matchAll(TEMPLATE_CSS_DECL)) {
        add(t.index + m.index + m[1].length, m[2], m[3]);
      }
    }
  }
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, d]) => d);
}

export function violation(d: Declaration): boolean {
  if (d.prop === "font-family") return !FAMILIES.includes(d.value);
  if (d.prop === "font-size") return !SIZES.includes(d.value);
  if (d.prop === "font-weight") return !WEIGHTS.includes(d.value);
  return !SHORTHANDS.includes(d.value);
}

/** Lines of tokens.css that define the families or sit in the platform blocks. */
function tokensExemptLines(text: string): Set<number> {
  const exempt = new Set<number>();
  let inPlatform = false;
  text.split("\n").forEach((l, i) => {
    if (/^:root\[data-platform=/.test(l)) inPlatform = true;
    if (inPlatform || /--font-[a-z-]+\s*:/.test(l)) exempt.add(i + 1);
    if (inPlatform && l.includes("}")) inPlatform = false;
  });
  return exempt;
}

function findViolations(): string[] {
  const out: string[] = [];
  for (const path of walk(SRC)) {
    const rel = relative(SRC, path).split("\\").join("/");
    const isCss = rel.endsWith(".css");
    const isTs = /\.tsx?$/.test(rel) && !/\.test\./.test(rel);
    if (!isCss && !isTs) continue;
    const text = stripComments(readFileSync(path, "utf8"), isTs);
    const exempt = rel === "styles/tokens.css" ? tokensExemptLines(text) : new Set<number>();
    for (const d of scanDeclarations(text, isTs)) {
      if (exempt.has(d.line)) continue;
      if (violation(d)) out.push(`src/${rel}:${d.line}: ${d.prop}: ${d.value}`);
    }
  }
  return out;
}

describe("font contract", () => {
  it("allows only token families, sizes and weights in every stylesheet and style literal", () => {
    expect(findViolations()).toEqual([]);
  });
});

describe("font contract scanner", () => {
  const check = (css: string) =>
    scanDeclarations(stripComments(css, false), false).filter((d) => violation(d));

  it("ignores declarations inside comments", () => {
    expect(check("/* font-size: 11px; */\n.a { color: red; }")).toEqual([]);
  });

  it("flags the font shorthand unless it is inherit", () => {
    expect(check(".a { font: 13px monospace; }")).toHaveLength(1);
    expect(check(".a { font: inherit; }")).toEqual([]);
  });

  it("scans declarations inside @media blocks", () => {
    const found = check("@media (max-width: 600px) {\n  .a {\n    font-size: 11px;\n  }\n}");
    expect(found).toEqual([{ line: 3, prop: "font-size", value: "11px" }]);
  });

  it("does not mistake custom properties for font properties", () => {
    expect(check(":root { --diff-font-size: 13px; --text-xs: 12px; }")).toEqual([]);
  });

  it("scans TS style literals and skips values that are not literals", () => {
    const ts = stripComments(
      'const a = { fontFamily: "Inter", fontSize: size, fontWeight: "600" };',
      true,
    );
    const found = scanDeclarations(ts, true).filter((d) => violation(d));
    expect(found).toEqual([{ line: 1, prop: "font-family", value: "Inter" }]);
  });

  const checkTs = (src: string) =>
    scanDeclarations(stripComments(src, true), true).filter((d) => violation(d));

  it("flags a numeric fontSize", () => {
    expect(checkTs("const a = { fontSize: 14 };")).toEqual([
      { line: 1, prop: "font-size", value: "14" },
    ]);
  });

  it("allows a numeric fontWeight of 600", () => {
    expect(checkTs("const a = { fontWeight: 600 };")).toEqual([]);
  });

  it("flags a numeric fontWeight of 500", () => {
    expect(checkTs("const a = { fontWeight: 500 };")).toEqual([
      { line: 1, prop: "font-weight", value: "500" },
    ]);
  });

  it("flags a px template font size, which no file is exempt from", () => {
    expect(checkTs("const a = { fontSize: `${size}px` };")).toEqual([
      { line: 1, prop: "font-size", value: "${size}px" },
    ]);
  });

  it("flags a quoted kebab-case key whose value is not a token", () => {
    expect(checkTs(`const a = { "font-family": "Inter", 'font-size': "var(--text-sm)" };`)).toEqual(
      [{ line: 1, prop: "font-family", value: "Inter" }],
    );
  });

  it("flags a raw font size in template-literal CSS", () => {
    expect(checkTs("const css = `\n.a {\n  font-size: 11px;\n}\n`;")).toEqual([
      { line: 3, prop: "font-size", value: "11px" },
    ]);
  });

  it("allows a token font size in template-literal CSS", () => {
    expect(checkTs("const css = `.a { font-size: var(--text-sm); font-weight: 600; }`;")).toEqual(
      [],
    );
  });

  it("reports a numeric weight in template-literal CSS once", () => {
    expect(checkTs("const css = `.a { font-weight: 500; }`;")).toEqual([
      { line: 1, prop: "font-weight", value: "500" },
    ]);
  });
});
