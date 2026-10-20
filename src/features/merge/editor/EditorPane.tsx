import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import styles from "./EditorPane.module.css";

export interface EditorPaneProps {
  initialText: string;
  extensions: Extension[];
  onDocChange(text: string): void;
  viewRef: RefObject<EditorView | null>;
  ariaLabel: string;
}

const paneTheme = EditorView.theme({
  "&": { height: "100%", background: "var(--color-bg)", color: "var(--color-text)" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.8125rem",
    lineHeight: "1.4",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--color-text)" },
  ".cm-gutters": {
    background: "var(--color-bg)",
    color: "var(--color-text-muted)",
    borderRight: "1px solid var(--color-border)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    background: "var(--color-line-selected)",
  },
  "&.cm-focused": { outline: "2px solid var(--color-accent)", outlineOffset: "-2px" },
});

/** One CodeMirror view, mounted once with `initialText`; later changes go through `viewRef`. */
export function EditorPane({
  initialText,
  extensions,
  onDocChange,
  viewRef,
  ariaLabel,
}: EditorPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const docChanged = useEffectEvent((text: string) => onDocChange(text));
  useEffect(() => {
    const view = new EditorView({
      doc: initialText,
      parent: host.current as HTMLDivElement,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) docChanged(u.state.doc.toString());
        }),
        syntaxHighlighting(classHighlighter),
        paneTheme,
        ...extensions,
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view mounts once; later changes go through viewRef (effects and compartments).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} className={styles.pane} />;
}
