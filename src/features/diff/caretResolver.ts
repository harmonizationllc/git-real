import type { Side } from "./model/selection";

export interface CaretHit {
  row: number;
  side: Side;
  offset: number;
}

export type CaretResolver = (x: number, y: number) => CaretHit | null;

type CaretDocument = Document & {
  caretRangeFromPoint?(x: number, y: number): Range | null;
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
};

/** The caret's node and offset at a point, from whichever caret API the engine has. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as CaretDocument;
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    return range && { node: range.startContainer, offset: range.startOffset };
  }
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos && { node: pos.offsetNode, offset: pos.offset };
  }
  return null;
}

/** The UTF-16 offset into the line of `offset` in `node`, counting the text nodes before it. */
function lineOffset(code: Element, node: Node, offset: number): number {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let before = 0;
  for (let t = walker.nextNode(); t !== null && t !== node; t = walker.nextNode()) {
    before += t.textContent!.length;
  }
  return before + offset;
}

/**
 * Maps a viewport point to the row, side and line offset under it, using the viewer's DOM
 * contract: wrapper[data-index] > [data-side] > code[data-line-text]. A point on the row but
 * outside the text snaps to the start (left of the text) or the end (right of it).
 */
export function domCaretResolver(container: HTMLElement): CaretResolver {
  return (x, y) => {
    const hit = container.ownerDocument.elementFromPoint(x, y);
    const wrapper = hit?.closest<HTMLElement>("[data-index]");
    const sideEl = hit?.closest<HTMLElement>("[data-side]");
    // An empty split cell has no code, so it shows no line to put a caret in.
    const code = sideEl?.querySelector("code[data-line-text]");
    if (!hit || !wrapper || !sideEl || !code) return null;
    const row = Number(wrapper.dataset.index);
    const side = sideEl.dataset.side as Side;
    if (!code.contains(hit)) {
      const right = x >= code.getBoundingClientRect().left;
      return { row, side, offset: right ? code.textContent!.length : 0 };
    }
    const caret = caretAt(x, y);
    return caret && { row, side, offset: lineOffset(code, caret.node, caret.offset) };
  };
}
