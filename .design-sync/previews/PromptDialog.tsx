import { PromptDialog } from "git-real";

const noop = () => {};

/** Naming a new branch: the label, an empty field and the default confirm label. */
export const Basic = () => (
  <PromptDialog
    open
    title="Create branch"
    label="Branch name"
    confirmLabel="Create"
    error={null}
    pending={false}
    onConfirm={noop}
    onCancel={noop}
  />
);

/** Renaming starts with the current name selected, and offers a checkbox option. */
export const WithInitialValueAndCheckbox = () => (
  <PromptDialog
    open
    title="Rename branch"
    label="New name"
    initialValue="feature/tokens"
    confirmLabel="Rename"
    checkbox={{ label: "Also rename the remote branch", checked: true, onChange: noop }}
    error={null}
    pending={false}
    onConfirm={noop}
    onCancel={noop}
  />
);

/** A failed action shows its message under the field. */
export const WithError = () => (
  <PromptDialog
    open
    title="Create tag"
    label="Tag name"
    initialValue="v0.4.0"
    confirmLabel="Create"
    error={{ kind: "io", message: "A tag named v0.4.0 already exists." }}
    pending={false}
    onConfirm={noop}
    onCancel={noop}
  />
);

/** While the action runs the field and both buttons disable. */
export const Pending = () => (
  <PromptDialog
    open
    title="Create branch"
    label="Branch name"
    initialValue="fix/graph-lane-overlap"
    confirmLabel="Create"
    error={null}
    pending
    onConfirm={noop}
    onCancel={noop}
  />
);
