import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineContent } from "./LineContent";
import type { Token } from "./model/highlight";
import type { Range } from "./model/wordDiff";

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
    expect(container.querySelector("code")?.textContent).toBe(" ");
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
