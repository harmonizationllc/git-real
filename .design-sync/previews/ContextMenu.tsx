import { ContextMenu } from "git-real";

const noop = () => {};

/** A branch row's menu: plain items first, the destructive one last. */
export const BranchMenu = () => (
  <ContextMenu
    open
    x={16}
    y={16}
    onClose={noop}
    items={[
      { id: "checkout", label: "Checkout", onSelect: noop },
      { id: "merge", label: "Merge into main", onSelect: noop },
      { id: "rename", label: "Rename…", onSelect: noop },
      { id: "delete", label: "Delete branch", danger: true, onSelect: noop },
    ]}
  />
);

/** Disabled items carry a tooltip explaining why. */
export const WithDisabled = () => (
  <ContextMenu
    open
    x={16}
    y={16}
    onClose={noop}
    items={[
      { id: "stage", label: "Stage", onSelect: noop },
      {
        id: "unstage",
        label: "Unstage",
        disabled: true,
        title: "Nothing is staged",
        onSelect: noop,
      },
      { id: "open", label: "Open in editor", onSelect: noop },
      { id: "discard", label: "Discard changes", danger: true, onSelect: noop },
    ]}
  />
);
