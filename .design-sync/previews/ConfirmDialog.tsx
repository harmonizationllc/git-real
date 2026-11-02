import { ConfirmDialog } from "git-real";

const noop = () => {};

/** The plain confirmation: a title, a short body and the default labels. */
export const Basic = () => (
  <ConfirmDialog
    open
    title="Delete branch feature/tokens?"
    body={<p>The branch is fully merged into main. Deleting it cannot be undone from Git Real.</p>}
    confirmLabel="Delete"
    onConfirm={noop}
    onCancel={noop}
  />
);

/** Destructive actions use the danger style on the confirm button. */
export const Danger = () => (
  <ConfirmDialog
    open
    title="Discard changes to 3 files?"
    body={
      <>
        <p>This throws away the working-tree changes in:</p>
        <ul>
          <li>src/app/App.tsx</li>
          <li>src/styles/tokens.css</li>
          <li>README.md</li>
        </ul>
      </>
    }
    confirmLabel="Discard"
    danger
    onConfirm={noop}
    onCancel={noop}
  />
);

/** While the action runs both buttons disable and the confirm reads "Working…". */
export const Pending = () => (
  <ConfirmDialog
    open
    title="Force push to origin/main?"
    body={<p>The remote branch has 2 commits that are not in your history.</p>}
    confirmLabel="Force push"
    danger
    pending
    onConfirm={noop}
    onCancel={noop}
  />
);
