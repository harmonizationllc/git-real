import { javascriptLanguage } from "@codemirror/lang-javascript";
import { LanguageDescription } from "@codemirror/language";
import type { Parser } from "@lezer/common";
import { Tree } from "@lezer/common";
import { describe, expect, it, vi } from "vitest";
import { L, hunk } from "../../../test/diffFixtures";
import {
  highlightHunk,
  highlightText,
  languageFor,
  loadParser,
  sideText,
  tokenize,
} from "./highlight";

const parser = javascriptLanguage.parser;

// Contract: a grammar is chosen from the file name, null when none matches.
describe("languageFor", () => {
  it.each([
    ["src/app.ts", "TypeScript"],
    ["main.rs", "Rust"],
    ["README.md", "Markdown"],
  ])("should match %s to %s", (path, name) => {
    expect(languageFor(path)?.name).toBe(name);
  });
  it("should be null for an unknown extension", () => {
    expect(languageFor("Makefile.weird-ext")).toBeNull();
  });
  it("should be null for a name without an extension", () => {
    expect(languageFor("noext")).toBeNull();
  });
});

// Contract: loadParser loads once per language, shares the promise, and never caches a failure.
describe("loadParser", () => {
  const support = { language: { parser } } as never;
  const describeLang = (name: string): LanguageDescription =>
    LanguageDescription.of({
      name,
      extensions: [`x${name}`],
      load: () => Promise.resolve(support),
    });

  it("should resolve to the language parser", async () => {
    await expect(loadParser(describeLang("ResolveLang"))).resolves.toBe(parser);
  });
  it("should load a language only once for repeated calls", async () => {
    const desc = describeLang("OnceLang");
    const load = vi.spyOn(desc, "load").mockResolvedValue(support);
    await loadParser(desc);
    await loadParser(desc);
    expect(load).toHaveBeenCalledOnce();
  });
  it("should not cache a rejected load", async () => {
    const desc = describeLang("RetryLang");
    vi.spyOn(desc, "load")
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce(support);
    await expect(loadParser(desc)).rejects.toThrow("chunk failed");
    await expect(loadParser(desc)).resolves.toBe(parser);
  });
});

// Contract: tokenize returns one token array per line of the input text.
describe("tokenize", () => {
  it("should return one token array per line, concatenating back to the line", () => {
    const lines = tokenize("const a = 1;\n// c\n", parser);
    expect(lines).toHaveLength(3);
    expect(lines[0].map((t) => t.text).join("")).toBe("const a = 1;");
    expect(lines[2]).toEqual([]);
  });
  it("should classify keywords", () => {
    const [first] = tokenize("const a = 1;", parser);
    expect(first.find((t) => t.text === "const")?.className).toContain("tok-");
  });
  it("should classify numbers", () => {
    const [first] = tokenize("const a = 1;", parser);
    expect(first.find((t) => t.text === "1")?.className).toBe("tok-number");
  });
  it("should classify comments", () => {
    const [line] = tokenize("// c", parser);
    expect(line[0]).toEqual({ text: "// c", className: "tok-comment" });
  });
  it("should give unclassified text a null class", () => {
    expect(tokenize("a = 1", parser)).toEqual([
      [
        { text: "a", className: "tok-variableName" },
        { text: " ", className: null },
        { text: "=", className: "tok-operator" },
        { text: " ", className: null },
        { text: "1", className: "tok-number" },
      ],
    ]);
  });
  it("should return a single empty line for empty text", () => {
    expect(tokenize("", parser)).toEqual([[]]);
  });
  it("should return two empty lines for a lone newline", () => {
    expect(tokenize("\n", parser)).toEqual([[], []]);
  });
  it("should tokenize text with no trailing newline", () => {
    const [a, b] = tokenize("let x;\nlet y", parser);
    expect(b.map((t) => t.text).join("")).toBe("let y");
    expect(a.map((t) => t.text).join("")).toBe("let x;");
  });
  it("should span a block comment across lines", () => {
    const [a, b] = tokenize("/* x\ny */", parser);
    expect(a[0].className).toBe("tok-comment");
    expect(b[0].className).toBe("tok-comment");
  });
  it("should keep a carriage return in the line text for CRLF content", () => {
    const [a, b] = tokenize("let x;\r\nlet y;", parser);
    expect(a.map((t) => t.text).join("")).toBe("let x;\r");
    expect(b.map((t) => t.text).join("")).toBe("let y;");
  });
  it("should split a token spanning three lines into one token per line", () => {
    const lines = tokenize("/* a\nb\nc */", parser);
    expect(lines).toEqual([
      [{ text: "/* a", className: "tok-comment" }],
      [{ text: "b", className: "tok-comment" }],
      [{ text: "c */", className: "tok-comment" }],
    ]);
  });
  it("should handle empty lines inside a block comment", () => {
    const lines = tokenize("/* x\n\ny */", parser);
    expect(lines.map((l) => l.length)).toEqual([1, 0, 1]);
  });
});

// Contract: sideText flattens one side of a hunk and records which hunk lines it used.
describe("sideText", () => {
  const h = hunk([
    L("context", "c0"),
    L("deletion", "d1"),
    L("addition", "a2"),
    L("context", "c3"),
  ]);
  it("should build the old side from context plus deletions", () => {
    expect(sideText(h, "old")).toEqual({ text: "c0\nd1\nc3", lineIndices: [0, 1, 3] });
  });
  it("should build the new side from context plus additions", () => {
    expect(sideText(h, "new")).toEqual({ text: "c0\na2\nc3", lineIndices: [0, 2, 3] });
  });
  it("should give empty text for a hunk with no lines", () => {
    expect(sideText(hunk([]), "new")).toEqual({ text: "", lineIndices: [] });
  });
});

// Contract: highlightHunk returns tokens for every line, indexed like hunk.lines.
describe("highlightHunk", () => {
  const h = hunk([L("context", "let x = 1;"), L("deletion", "// old"), L("addition", "// new")]);
  it("should return one entry per hunk line", () => {
    expect(highlightHunk(h, parser)).toHaveLength(3);
  });
  it("should tokenize context lines", () => {
    expect(
      highlightHunk(h, parser)[0]
        ?.map((t) => t.text)
        .join(""),
    ).toBe("let x = 1;");
  });
  it("should tokenize deletions from the old side", () => {
    expect(highlightHunk(h, parser)[1]?.[0]).toEqual({
      text: "// old",
      className: "tok-comment",
    });
  });
  it("should tokenize additions from the new side", () => {
    expect(highlightHunk(h, parser)[2]?.[0]).toEqual({
      text: "// new",
      className: "tok-comment",
    });
  });
  it("should give context lines the new side's tokens", () => {
    const ctx = hunk([L("deletion", "/*"), L("context", "x"), L("addition", "y")]);
    // old side opens a block comment around "x"; the new side does not.
    expect(highlightHunk(ctx, parser)[1]?.[0]?.className).toBe("tok-variableName");
  });
});

// Contract: a hunk with only one kind of change is highlighted from the side that has lines.
describe("highlightHunk one-sided hunks", () => {
  it("should highlight a deletion-only hunk", () => {
    const out = highlightHunk(hunk([L("deletion", "// a"), L("deletion", "let x = 1;")]), parser);
    expect(out[0]).toEqual([{ text: "// a", className: "tok-comment" }]);
    expect(out[1]?.map((t) => t.text).join("")).toBe("let x = 1;");
  });
  it("should highlight an addition-only hunk", () => {
    const out = highlightHunk(hunk([L("addition", "// a"), L("addition", "let x = 1;")]), parser);
    expect(out[0]).toEqual([{ text: "// a", className: "tok-comment" }]);
    expect(out[1]?.find((t) => t.text === "1")?.className).toBe("tok-number");
  });
  it("should return an empty array for a hunk with no lines", () => {
    expect(highlightHunk(hunk([]), parser)).toEqual([]);
  });
});

// Contract: highlightText tokenizes whole-file lines as one text, one token array per line.
describe("highlightText", () => {
  it("should return one token array per input line", () => {
    const out = highlightText(["const a = 1;", "// c"], parser);
    expect(out).toHaveLength(2);
  });
  it("should classify tokens in each line", () => {
    const out = highlightText(["const a = 1;", "// c"], parser);
    expect(out[0]?.find((t) => t.text === "1")?.className).toBe("tok-number");
    expect(out[1]?.[0]?.className).toBe("tok-comment");
  });
  it("should return an empty token array for a blank line", () => {
    const out = highlightText(["const a = 1;", "", "const b = 2;"], parser);
    expect(out[1]).toEqual([]);
  });
  it("should parse the lines as one text so a block comment spans lines", () => {
    const out = highlightText(["/* a", "b */"], parser);
    expect(out[1]?.[0]?.className).toBe("tok-comment");
  });
  it("should return [] for no lines", () => {
    expect(highlightText([], parser)).toEqual([]);
  });
  it("should return one entry per line for lines with a blank in the middle", () => {
    expect(highlightText(["a", "", "b"], parser)).toHaveLength(3);
  });
});

// Contract: highlightText keeps one entry per input line even when the parser yields no spans.
describe("highlightText without spans", () => {
  const noSpans = { parse: () => Tree.empty } as unknown as Parser;
  it("should emit each line as one unclassified token", () => {
    expect(highlightText(["ab", "c"], noSpans)).toEqual([
      [{ text: "ab", className: null }],
      [{ text: "c", className: null }],
    ]);
  });
  it("should emit an empty token array for blank lines", () => {
    expect(highlightText(["ab", "", "c"], noSpans)).toEqual([
      [{ text: "ab", className: null }],
      [],
      [{ text: "c", className: null }],
    ]);
  });
  it("should return one empty token array for a single empty line", () => {
    expect(highlightText([""], parser)).toEqual([[]]);
  });
  it("should return one entry per line, whatever the line count", () => {
    for (const n of [1, 2, 5]) {
      expect(
        highlightText(
          Array.from({ length: n }, () => "x = 1"),
          parser,
        ),
      ).toHaveLength(n);
    }
  });
});
