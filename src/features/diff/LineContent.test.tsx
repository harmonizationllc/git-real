import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineContent } from "./LineContent";
import type { Token } from "./model/highlight";
import type { Range } from "./model/wordDiff";
import styles from "./LineContent.module.css";

function setup(text: string, tokens: Token[] | null = null, ranges: Range[] = [], eof = false) {
  const view = render(
    <LineContent text={text} tokens={tokens} ranges={ranges} noNewlineAtEof={eof} />,
  );
  const marked = Array.from(view.container.querySelectorAll("mark"))
    .map((m) => m.textContent)
    .join("");
  return { ...view, marked };
}

// Contract: plain text renders inside a <code> element when there are no tokens.
describe("LineContent plain text", () => {
  it("should render the text inside a code element when tokens is null", () => {
    const { container } = setup("const a = 1");
    expect(container.querySelector("code")).toHaveTextContent("const a = 1");
  });

  it("should not mark anything when there are no ranges", () => {
    const { container } = setup("const a = 1");
    expect(container.querySelector("mark")).toBeNull();
  });
});

// Contract: syntax tokens become spans carrying their class; a null class adds none.
describe("LineContent tokens", () => {
  const tokens: Token[] = [
    { text: "let ", className: null },
    { text: "1", className: "tok-number" },
  ];

  it("should render a token with its class name", () => {
    const { getByText } = setup("let 1", tokens);
    expect(getByText("1")).toHaveClass("tok-number");
  });

  it("should add no token class for a null className", () => {
    const { container } = setup("let 1", tokens);
    expect(container.querySelectorAll("[class*='tok-']")).toHaveLength(1);
  });

  it("should keep the full text when tokens are given", () => {
    const { container } = setup("let 1", tokens);
    expect(container.querySelector("code")).toHaveTextContent("let 1");
  });
});

// Contract: word-diff ranges are wrapped in <mark>, splitting tokens at the range edges.
describe("LineContent word-diff ranges", () => {
  it("should wrap exactly the ranged text in a mark", () => {
    const { marked } = setup("const b = 1", null, [{ start: 6, end: 7 }]);
    expect(marked).toBe("b");
  });

  it("should keep the surrounding text outside the mark", () => {
    const { container } = setup("const b = 1", null, [{ start: 6, end: 7 }]);
    expect(container.querySelector("code")).toHaveTextContent("const b = 1");
  });

  it("should mark exactly the range text when it crosses a token boundary", () => {
    const tokens: Token[] = [
      { text: "const b", className: "tok-keyword" },
      { text: " = 1", className: null },
    ];
    const { marked } = setup("const b = 1", tokens, [{ start: 4, end: 9 }]);
    expect(marked).toBe("t b =");
  });

  it("should keep the token class on marked text", () => {
    const tokens: Token[] = [{ text: "const b = 1", className: "tok-keyword" }];
    const { container } = setup("const b = 1", tokens, [{ start: 6, end: 7 }]);
    expect(container.querySelector("mark .tok-keyword, mark.tok-keyword")).not.toBeNull();
  });

  it("should mark every range when several are given", () => {
    const { marked } = setup("const b = 1", null, [
      { start: 0, end: 5 },
      { start: 10, end: 11 },
    ]);
    expect(marked).toBe("const1");
  });
});

// Contract: an empty line keeps its height with a non-breaking space.
describe("LineContent empty line", () => {
  it("should render a non-breaking space when the text is empty", () => {
    const { container } = setup("");
    expect(container.querySelector("code")?.textContent).toBe("\u00a0");
  });

  it("should not render a placeholder when the text is not empty", () => {
    const { container } = setup("x");
    expect(container.querySelector("code")?.textContent).toBe("x");
  });
});

// Contract: a missing trailing newline is flagged with a titled marker.
describe("LineContent no newline at end of file", () => {
  it("should append a marker with the symbol and title when noNewlineAtEof is set", () => {
    const { getByTitle } = setup("x", null, [], true);
    expect(getByTitle("No newline at end of file")).toHaveTextContent("⏎");
  });

  it("should render no marker when noNewlineAtEof is false", () => {
    const { queryByTitle } = setup("x");
    expect(queryByTitle("No newline at end of file")).toBeNull();
  });

  it("should still render the marker for an empty line", () => {
    const { getByTitle } = setup("", null, [], true);
    expect(getByTitle("No newline at end of file")).toBeInTheDocument();
  });
});

// Contract: range edges that coincide with token edges, cover the line, overlap or touch
// still mark exactly the ranged characters, keep the full text and keep token classes.
describe("LineContent range edge cases", () => {
  const tokens: Token[] = [
    { text: "const", className: "tok-keyword" },
    { text: " b = 1", className: null },
  ];

  it("should mark exactly the first token when the range ends at the token boundary", () => {
    const { marked, container } = setup("const b = 1", tokens, [{ start: 0, end: 5 }]);
    expect(marked).toBe("const");
    expect(container.querySelector("code")).toHaveTextContent("const b = 1");
    expect(container.querySelector("mark .tok-keyword")).not.toBeNull();
  });

  it("should mark exactly the second token when the range starts at the token boundary", () => {
    const { marked, container } = setup("const b = 1", tokens, [{ start: 5, end: 11 }]);
    expect(marked).toBe(" b = 1");
    expect(container.querySelector("code")).toHaveTextContent("const b = 1");
    expect(container.querySelector(".tok-keyword")?.closest("mark")).toBeNull();
  });

  it("should not create empty pieces when a range edge equals a token edge", () => {
    const { container } = setup("const b = 1", tokens, [{ start: 0, end: 5 }]);
    const empties = Array.from(container.querySelectorAll("code span")).filter(
      (s) => s.textContent === "",
    );
    expect(empties).toHaveLength(0);
  });

  it("should mark the whole line when the range covers all of it", () => {
    const { marked, container } = setup("const b = 1", tokens, [{ start: 0, end: 11 }]);
    expect(marked).toBe("const b = 1");
    expect(container.querySelector("code")).toHaveTextContent("const b = 1");
  });

  it("should mark the whole line without tokens when the range covers all of it", () => {
    const { marked } = setup("abc", null, [{ start: 0, end: 3 }]);
    expect(marked).toBe("abc");
  });

  it("should mark the union of overlapping ranges and no more", () => {
    const { marked, container } = setup("const b = 1", null, [
      { start: 0, end: 4 },
      { start: 2, end: 6 },
    ]);
    expect(marked).toBe("const ");
    expect(container.querySelector("code")).toHaveTextContent("const b = 1");
  });

  it("should mark both of two adjacent ranges and nothing between them", () => {
    const { marked } = setup("const b = 1", null, [
      { start: 0, end: 2 },
      { start: 2, end: 5 },
    ]);
    expect(marked).toBe("const");
  });

  it("should mark a range regardless of the order the ranges are given in", () => {
    const { marked } = setup("const b = 1", null, [
      { start: 10, end: 11 },
      { start: 0, end: 5 },
    ]);
    expect(marked).toBe("const1");
  });

  it("should leave a gap between disjoint ranges unmarked", () => {
    const { marked } = setup("abcdef", null, [
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ]);
    expect(marked).toBe("af");
  });
});

// Contract: a whitespace-only line renders its own spaces, not the empty-line placeholder.
describe("LineContent whitespace-only line", () => {
  it("should render the spaces themselves", () => {
    const { container } = setup("   ");
    expect(container.querySelector("code")?.textContent).toBe("   ");
  });

  it("should render a tab-only line as the tab", () => {
    const { container } = setup("\t");
    expect(container.querySelector("code")?.textContent).toBe("\t");
  });

  it("should mark whitespace covered by a range", () => {
    const { marked } = setup("a  b", null, [{ start: 1, end: 3 }]);
    expect(marked).toBe("  ");
  });

  it("should put the no-newline marker after the text of a non-empty line", () => {
    const { container } = setup("x", null, [], true);
    expect(container.querySelector("code")?.textContent).toBe("x⏎");
  });

  it("should keep the placeholder space before the marker on an empty line", () => {
    const { container } = setup("", null, [], true);
    expect(container.querySelector("code")?.textContent).toBe("\u00a0⏎");
  });
});

/** Each text run under the code, with whether it sits in a word mark and in the selection. */
const runs = (container: HTMLElement) => {
  const code = container.querySelector("code")!;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const out: { text: string; marked: boolean; selected: boolean }[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement!;
    out.push({
      text: n.textContent ?? "",
      marked: parent.closest("mark") !== null,
      selected: parent.closest(`.${styles.selected}`) !== null,
    });
  }
  return out;
};

const selectedText = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(`.${styles.selected}`))
    .map((e) => e.textContent)
    .join("");

// Contract: the selected range adds its bounds to the piece cuts and wraps the selected pieces in
// span.selected, combining with word marks and token classes.
describe("LineContent selected range", () => {
  const renderSelected = (
    text: string,
    selected: Range | null | undefined,
    ranges: Range[] = [],
    tokens: Token[] | null = null,
  ) =>
    render(
      <LineContent
        text={text}
        tokens={tokens}
        ranges={ranges}
        noNewlineAtEof={false}
        selected={selected}
      />,
    );

  it("should wrap the middle piece in a span with the selected class", () => {
    const { container } = renderSelected("abcdefg", { start: 2, end: 5 });
    const sel = container.querySelectorAll(`.${styles.selected}`);
    expect(sel).toHaveLength(1);
    expect(sel[0].tagName).toBe("SPAN");
    expect(sel[0].textContent).toBe("cde");
  });

  it("should select nothing else", () => {
    const { container } = renderSelected("abcdefg", { start: 2, end: 5 });
    expect(runs(container)).toEqual([
      { text: "ab", marked: false, selected: false },
      { text: "cde", marked: false, selected: true },
      { text: "fg", marked: false, selected: false },
    ]);
  });

  it("should keep the full text", () => {
    const { container } = renderSelected("abcdefg", { start: 2, end: 5 });
    expect(container.querySelector("code")?.textContent).toBe("abcdefg");
  });

  it("should combine the selection cuts with word-mark cuts", () => {
    const { container } = renderSelected("abcdefg", { start: 2, end: 5 }, [{ start: 3, end: 6 }]);
    expect(runs(container)).toEqual([
      { text: "ab", marked: false, selected: false },
      { text: "c", marked: false, selected: true },
      { text: "de", marked: true, selected: true },
      { text: "f", marked: true, selected: false },
      { text: "g", marked: false, selected: false },
    ]);
  });

  it("should keep the token class on selected text", () => {
    const tokens: Token[] = [
      { text: "let ", className: "tok-keyword" },
      { text: "x", className: "tok-variable" },
    ];
    const { container } = renderSelected("let x", { start: 2, end: 5 }, [], tokens);
    expect(selectedText(container)).toBe("t x");
    const x = Array.from(container.querySelectorAll(".tok-variable")).find(
      (e) => e.textContent === "x",
    )!;
    expect(x.closest(`.${styles.selected}`)).not.toBeNull();
    const t = Array.from(container.querySelectorAll(".tok-keyword")).find(
      (e) => e.textContent === "t ",
    )!;
    expect(t.closest(`.${styles.selected}`)).not.toBeNull();
  });

  it("should select the whole line when the range covers all of it", () => {
    const { container } = renderSelected("abc", { start: 0, end: 3 });
    expect(runs(container)).toEqual([{ text: "abc", marked: false, selected: true }]);
  });

  it("should select nothing when selected is null", () => {
    const { container } = renderSelected("abcdefg", null);
    expect(container.querySelector(`.${styles.selected}`)).toBeNull();
  });

  it("should select nothing when selected is absent", () => {
    const { container } = renderSelected("abcdefg", undefined);
    expect(container.querySelector(`.${styles.selected}`)).toBeNull();
  });

  it("should select nothing and add no empty piece for an empty range", () => {
    const { container } = renderSelected("abcdefg", { start: 3, end: 3 });
    expect(container.querySelector(`.${styles.selected}`)).toBeNull();
    expect(runs(container).every((r) => r.text.length > 0)).toBe(true);
  });

  it("should keep the placeholder and select nothing on an empty line", () => {
    const { container } = renderSelected("", { start: 0, end: 0 });
    expect(container.querySelector("code")?.textContent).toBe("\u00a0");
    expect(container.querySelector(`.${styles.selected}`)).toBeNull();
  });
});

// Contract: the code carries the line's own text length, so a caret resolver can clamp offsets
// past the no-newline marker or the empty-line placeholder; the placeholder is the NBSP escape.
describe("LineContent line length", () => {
  it("should carry the text length on the code", () => {
    const { container } = setup("const b = 1");
    expect(container.querySelector("code")).toHaveAttribute("data-line-length", "11");
  });

  it("should not count the no-newline marker", () => {
    const { container } = setup("xyz", null, [], true);
    expect(container.querySelector("code")).toHaveAttribute("data-line-length", "3");
  });

  it("should give an empty line length 0 and the NBSP placeholder as its only text", () => {
    const { container } = setup("");
    const code = container.querySelector("code")!;
    expect(code).toHaveAttribute("data-line-length", "0");
    expect(code.textContent).toBe("\u00a0");
  });
});
