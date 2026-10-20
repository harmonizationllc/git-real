import { EditorView } from "@codemirror/view";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorPane } from "./EditorPane";

function mount(overrides: Partial<Parameters<typeof EditorPane>[0]> = {}) {
  const viewRef: { current: EditorView | null } = { current: null };
  const onDocChange = vi.fn();
  const utils = render(
    <EditorPane
      initialText={"one\ntwo\n"}
      extensions={[]}
      onDocChange={onDocChange}
      viewRef={viewRef}
      ariaLabel="Conflict editor"
      {...overrides}
    />,
  );
  return { ...utils, viewRef, onDocChange };
}

// Contract: the pane mounts one CodeMirror view holding the initial text, labelled for assistive tech.
describe("EditorPane mounting", () => {
  it("should mount an EditorView with the initial text", () => {
    const { viewRef } = mount();
    expect(viewRef.current?.state.doc.toString()).toBe("one\ntwo\n");
  });
  it("should expose an editable textbox named by the aria label", () => {
    mount();
    expect(screen.getByRole("textbox", { name: "Conflict editor" })).toBeInTheDocument();
  });
});

// Contract: document changes are reported as the full text.
describe("EditorPane change reporting", () => {
  it("should call onDocChange with the new text after a dispatch", () => {
    const { viewRef, onDocChange } = mount();
    viewRef.current?.dispatch({ changes: { from: 0, to: 3, insert: "uno" } });
    expect(onDocChange).toHaveBeenCalledWith("uno\ntwo\n");
  });
  it("should not call onDocChange for a selection-only dispatch", () => {
    const { viewRef, onDocChange } = mount();
    viewRef.current?.dispatch({ selection: { anchor: 2 } });
    expect(onDocChange).not.toHaveBeenCalled();
  });
});

// Contract: the view is torn down with the component and the ref cleared.
describe("EditorPane unmounting", () => {
  it("should destroy the view on unmount", () => {
    const { viewRef, unmount } = mount();
    const view = viewRef.current as EditorView;
    const destroy = vi.spyOn(view, "destroy");
    unmount();
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("should clear the view ref on unmount", () => {
    const { viewRef, unmount } = mount();
    unmount();
    expect(viewRef.current).toBeNull();
  });
});

// Contract: caller-supplied extensions are part of the editor.
describe("EditorPane extensions", () => {
  it("should apply the extra extensions", () => {
    mount({ extensions: [EditorView.contentAttributes.of({ "data-extra": "yes" })] });
    expect(screen.getByRole("textbox", { name: "Conflict editor" })).toHaveAttribute(
      "data-extra",
      "yes",
    );
  });
  it("should still report document changes when extra extensions are supplied", () => {
    const { viewRef, onDocChange } = mount({
      extensions: [EditorView.contentAttributes.of({ "data-extra": "yes" })],
    });
    viewRef.current!.dispatch({ changes: { from: 0, insert: "zero\n" } });
    expect(onDocChange).toHaveBeenLastCalledWith("zero\none\ntwo\n");
  });
});
