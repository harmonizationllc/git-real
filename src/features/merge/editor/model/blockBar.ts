import { WidgetType, type EditorView } from "@codemirror/view";
import type { BlockLabels, TrackedBlock } from "./blocks";
import type { Choice } from "./markers";

export type PickFn = (view: EditorView, id: number, choice: Choice | "restore") => void;

/** The action bar above a conflict block: three choices while unresolved, else its state and Undo. */
export class BlockBarWidget extends WidgetType {
  constructor(
    private readonly block: TrackedBlock,
    private readonly index: number,
    private readonly labels: BlockLabels,
    private readonly onPick: PickFn,
  ) {
    super();
  }

  eq(other: BlockBarWidget): boolean {
    return (
      other.block.id === this.block.id &&
      other.block.state === this.block.state &&
      other.index === this.index &&
      other.labels.ours === this.labels.ours &&
      other.labels.theirs === this.labels.theirs
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-conflict-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", `Conflict ${this.index}`);
    const button = (text: string, choice: Choice | "restore") => {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = text;
      el.onclick = () => this.onPick(view, this.block.id, choice);
      bar.append(el);
    };
    const { ours, theirs } = this.labels;
    const state = this.block.state;
    if (state === "unresolved") {
      button(`Keep ${ours}`, "ours");
      button(`Take ${theirs}`, "theirs");
      button("Keep both", "both");
    } else {
      const label = document.createElement("span");
      label.textContent = {
        ours: `Kept ${ours}`,
        theirs: `Took ${theirs}`,
        both: "Kept both",
        custom: "Edited",
      }[state];
      bar.append(label);
      button("Undo", "restore");
    }
    return bar;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
