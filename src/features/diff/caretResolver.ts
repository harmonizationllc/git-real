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
 * contract: wrapper[data-index] > [data-side] > code[data-line-text][data-line-length]. A point
 * (or a caret) on the row but outside the text snaps to the start (left of the text) or the end
 * (right of it); an empty split cell gives offset 0. Offsets never pass the line's own length, so
 * the no-newline marker and an empty line's placeholder are not text.
 */
export function domCaretResolver(container: HTMLElement): CaretResolver {
  return (x, y) => {
    const hit = container.ownerDocument.elementFromPoint(x, y);
    const wrapper = hit?.closest<HTMLElement>("[data-index]");
    const sideEl = hit?.closest<HTMLElement>("[data-side]");
    if (!hit || !wrapper || !sideEl || !container.contains(wrapper)) return null;
    const row = Number(wrapper.dataset.index);
    const side = sideEl.dataset.side as Side;
    const code = sideEl.querySelector<HTMLElement>("code[data-line-text]");
    if (code === null) return { row, side, offset: 0 };
    const length = Number(code.dataset.lineLength);
    const snapped = { row, side, offset: x >= code.getBoundingClientRect().left ? length : 0 };
    if (!code.contains(hit)) return snapped;
    const caret = caretAt(x, y);
    if (caret === null) return null;
    if (!code.contains(caret.node)) return snapped;
    return { row, side, offset: Math.min(lineOffset(code, caret.node, caret.offset), length) };
  };
}
