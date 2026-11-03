import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { domCaretResolver } from "./caretResolver";

// Two unified rows and one split row, laid out the way the viewer renders them:
// wrapper[data-index] > row[data-side] > gutter span + code[data-line-text] > text spans.
const HTML = `
  <div data-index="0">
    <div data-side="old"><span class="gutter">1</span><code data-line-text><span>ab</span><span>cdef</span></code></div>
  </div>
  <div data-index="1">
    <div data-side="new"><span class="gutter">2</span><code data-line-text><span>one </span><span>two</span></code></div>
  </div>
  <div data-index="2">
    <div>
      <div data-side="old"><span class="gutter">3</span><code data-line-text><span>left</span></code></div>
      <div data-side="new"><span class="gutter">3</span><code data-line-text><span>right side</span></code></div>
    </div>
  </div>
`;

const CODE_RECT = { left: 50, right: 200, top: 0, bottom: 20, width: 150, height: 20, x: 50, y: 0 };

let container: HTMLElement;
let hitElement: Element | null;

const doc = document as unknown as Record<string, unknown>;
const stub = (name: string, value: unknown) =>
  Object.defineProperty(document, name, { value, configurable: true, writable: true });

const code = (row: number, side?: "old" | "new") =>
  container.querySelector<HTMLElement>(
    `[data-index="${row}"] ${side ? `[data-side="${side}"] ` : ""}code[data-line-text]`,
  )!;
const textNode = (el: Element, i: number) => el.querySelectorAll("span")[i].firstChild!;

function caretAt(node: Node, offset: number) {
  stub("caretRangeFromPoint", () => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    return range;
  });
}

beforeEach(() => {
  container = document.createElement("div");
  container.innerHTML = HTML;
  document.body.appendChild(container);
  for (const c of container.querySelectorAll<HTMLElement>("code")) {
    c.getBoundingClientRect = () => ({ ...CODE_RECT, toJSON: () => CODE_RECT }) as DOMRect;
  }
  hitElement = null;
  stub("elementFromPoint", () => hitElement);
});

afterEach(() => {
  container.remove();
  for (const name of ["elementFromPoint", "caretRangeFromPoint", "caretPositionFromPoint"]) {
    delete doc[name];
  }
});

// Contract: a point over a line's text maps to the row, the side and the UTF-16 offset into the
// whole line, counting the text of the spans before the caret's text node.
describe("domCaretResolver over text", () => {
  it("should add the preceding text length to the caret offset in a later text node", () => {
    hitElement = code(1);
    caretAt(textNode(code(1), 1), 2);
    expect(domCaretResolver(container)(100, 10)).toEqual({ row: 1, side: "new", offset: 6 });
  });

  it("should use the caret offset as is in the first text node", () => {
    hitElement = code(0);
    caretAt(textNode(code(0), 0), 1);
    expect(domCaretResolver(container)(100, 10)).toEqual({ row: 0, side: "old", offset: 1 });
  });

  it("should resolve a hit on a span inside the code", () => {
    hitElement = code(0).querySelectorAll("span")[1];
    caretAt(textNode(code(0), 1), 3);
    expect(domCaretResolver(container)(100, 10)).toEqual({ row: 0, side: "old", offset: 5 });
  });

  it("should take the side from the split cell under the point", () => {
    hitElement = code(2, "new");
    caretAt(textNode(code(2, "new"), 0), 5);
    expect(domCaretResolver(container)(100, 10)).toEqual({ row: 2, side: "new", offset: 5 });
  });

  it("should take the old side from the left split cell", () => {
    hitElement = code(2, "old");
    caretAt(textNode(code(2, "old"), 0), 2);
    expect(domCaretResolver(container)(100, 10)).toEqual({ row: 2, side: "old", offset: 2 });
  });
});

// Contract: a point on the row but outside the code snaps to the start (left of it) or the end
// (right of it) of the line.
describe("domCaretResolver outside the text", () => {
  it("should give offset 0 for a hit on the gutter", () => {
    hitElement = container.querySelector('[data-index="1"] .gutter');
    caretAt(textNode(code(0), 1), 3);
    expect(domCaretResolver(container)(10, 10)).toEqual({ row: 1, side: "new", offset: 0 });
  });

  it("should give the text length for a hit on the row right of the code", () => {
    hitElement = container.querySelector('[data-index="1"] [data-side]');
    caretAt(textNode(code(0), 1), 3);
    expect(domCaretResolver(container)(300, 10)).toEqual({ row: 1, side: "new", offset: 7 });
  });

  it("should give null for a point outside every row", () => {
    hitElement = container;
    caretAt(textNode(code(0), 1), 3);
    expect(domCaretResolver(container)(100, 10)).toBeNull();
  });

  it("should give null when nothing is under the point", () => {
    hitElement = null;
    caretAt(textNode(code(0), 1), 3);
    expect(domCaretResolver(container)(100, 10)).toBeNull();
  });
});

// Contract: caretPositionFromPoint is the fallback when caretRangeFromPoint is missing; with
// neither the resolver gives null.
describe("domCaretResolver caret APIs", () => {
  it("should fall back to caretPositionFromPoint", () => {
    hitElement = code(1);
    stub("caretRangeFromPoint", undefined);
    stub("caretPositionFromPoint", () => ({ offsetNode: textNode(code(1), 1), offset: 1 }));
    expect(domCaretResolver(container)(100, 10)).toEqual({ row: 1, side: "new", offset: 5 });
  });

  it("should give null when neither caret API exists", () => {
    hitElement = code(1);
    stub("caretRangeFromPoint", undefined);
    stub("caretPositionFromPoint", undefined);
    expect(domCaretResolver(container)(100, 10)).toBeNull();
  });
});
