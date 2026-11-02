import { SplitHandle } from "git-real";

const noop = () => {};

const pane = {
  background: "var(--color-surface)",
  borderRadius: 4,
  color: "var(--color-text-muted)",
  fontSize: "var(--text-sm)",
  padding: 8,
} as const;

/** A column separator between the branches list and the history. */
export const Vertical = () => (
  <div style={{ display: "flex", width: 360, height: 160 }}>
    <div style={{ ...pane, flex: "0 0 140px" }}>Branches</div>
    <SplitHandle
      label="Resize branches"
      value={140}
      min={100}
      max={240}
      step={16}
      onChange={noop}
      onReset={noop}
    />
    <div style={{ ...pane, flex: 1 }}>History</div>
  </div>
);

/** A section separator between stacked panes. */
export const Horizontal = () => (
  <div style={{ display: "flex", flexDirection: "column", width: 360, height: 160 }}>
    <div style={{ ...pane, flex: "0 0 70px" }}>Unstaged changes</div>
    <SplitHandle
      label="Resize unstaged"
      orientation="horizontal"
      value={70}
      min={40}
      max={120}
      step={16}
      onChange={noop}
      onReset={noop}
    />
    <div style={{ ...pane, flex: 1 }}>Staged changes</div>
  </div>
);
