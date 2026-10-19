import { useCallback, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { PromptDialog } from "../../components/PromptDialog";
import type { BranchList, HeadState, RepoId } from "../../lib/ipc";
import { IN_PROGRESS_TITLE, headName } from "../merge/operationCopy";
import { useCanFastForward } from "../merge/useCanFastForward";
import { useIntegrationActions, type IntegrationRequest } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { RepoError } from "../repo/RepoError";
import { BranchGroup } from "./BranchGroup";
import { BranchRow, type BranchTarget } from "./BranchRow";
import styles from "./BranchesPanel.module.css";
import { filterBranches } from "./branchFilter";
import { useBranchActions } from "./useBranchActions";
import { useBranches } from "./useBranches";

export interface BranchesPanelProps {
  repoId: RepoId;
}

interface MenuState {
  x: number;
  y: number;
  target: BranchTarget;
}

type Dialog =
  | { kind: "create"; title: string; startPoint: string | null; checkout: boolean }
  | { kind: "rename"; name: string }
  | { kind: "deleteLocal"; name: string }
  | { kind: "forceDelete"; name: string }
  | { kind: "deleteRemote"; remote: string; name: string };

type CreateDialog = Extract<Dialog, { kind: "create" }>;

const createDialog = (title: string, startPoint: string | null): CreateDialog => ({
  kind: "create",
  title,
  startPoint,
  checkout: true,
});

/** The name git resolves for a row: `name` for local, `remote/name` for remote-tracking. */
const branchId = (t: BranchTarget): string =>
  t.kind === "local" ? t.branch.name : `${t.branch.remote}/${t.branch.name}`;

/** The non-interactive first Local row for a HEAD that is not on a born branch. */
function headRow(head: HeadState) {
  if (head.kind === "branch") return undefined;
  const text =
    head.kind === "detached"
      ? `Detached at ${head.oid.slice(0, 7)}`
      : `${head.name} (no commits yet)`;
  return (
    <p className={styles.headRow} aria-current="true">
      {text}
    </p>
  );
}

export function BranchesPanel({ repoId }: BranchesPanelProps) {
  const { branches, error: listError, refetch } = useBranches(repoId);
  const actions = useBranchActions(repoId);
  const { state } = useOperationState(repoId);
  const integration = useIntegrationActions(repoId);
  const pending = actions.pending || integration.pending;
  const panelError = actions.error ?? integration.error;
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuBranch =
    menu === null || (menu.target.kind === "local" && menu.target.branch.isHead)
      ? null
      : branchId(menu.target);
  const ff = useCanFastForward(repoId, menuBranch);

  const clearErrors = () => {
    actions.clearError();
    integration.clearError();
  };

  // A newer integration failure must not hide behind an older, undismissed panel error.
  const runIntegration = (req: IntegrationRequest) => {
    clearErrors();
    void integration.run(req);
  };

  // Every dialog opens clean: an earlier panel error must not reappear inside it.
  const openDialog = (d: Dialog) => {
    clearErrors();
    setDialog(d);
  };

  const closeDialog = () => {
    setDialog(null);
    clearErrors();
  };

  const activate = (t: BranchTarget) => {
    if (pending) return;
    if (t.kind === "local") {
      if (!t.branch.isHead) void actions.run({ action: "checkout", name: t.branch.name });
    } else {
      void actions.run({ action: "checkoutRemote", remote: t.branch.remote, name: t.branch.name });
    }
  };

  const confirmCreate = async (d: CreateDialog, name: string) => {
    const err = await actions.run({
      action: "create",
      name,
      startPoint: d.startPoint,
      checkout: d.checkout,
    });
    if (err === null) closeDialog();
  };

  const confirmRename = async (oldName: string, newName: string) => {
    const err = await actions.run({ action: "rename", oldName, newName });
    if (err === null) closeDialog();
  };

  // A confirm dialog has no error slot: other than the force-delete hand-off, a failure closes
  // the dialog and the error shows in the panel.
  const confirmDeleteLocal = async (name: string) => {
    const err = await actions.run({ action: "delete", name, force: false });
    if (err?.kind === "branchNotMerged") {
      actions.clearError();
      setDialog({ kind: "forceDelete", name });
    } else {
      setDialog(null);
    }
  };

  const confirmForceDelete = async (name: string) => {
    await actions.run({ action: "delete", name, force: true });
    setDialog(null);
  };

  const confirmDeleteRemote = async (remote: string, name: string) => {
    await actions.run({ action: "deleteRemote", remote, name });
    setDialog(null);
  };

  /** Merge, fast-forward and rebase of the current branch with the row's branch. */
  const integrationItems = (target: BranchTarget, head: HeadState): MenuItem[] => {
    const b = branchId(target);
    const cur = headName(head);
    const gateTitle =
      state?.kind !== "none"
        ? IN_PROGRESS_TITLE
        : head.kind !== "branch"
          ? "Check out a branch first"
          : undefined;
    const ffTitle = ff.isLoading
      ? "Checking…"
      : ff.check === "upToDate"
        ? "Already up to date"
        : ff.check === "diverged"
          ? `${cur} and ${b} have diverged`
          : undefined;
    const fastForwardTitle = gateTitle ?? ffTitle;
    return [
      {
        id: "merge",
        label: `Merge ${b} into ${cur}`,
        disabled: pending || gateTitle !== undefined,
        title: gateTitle,
        onSelect: () => runIntegration({ action: "merge", branch: b }),
      },
      {
        id: "fastForward",
        label: `Fast-forward ${cur} to ${b}`,
        disabled: pending || fastForwardTitle !== undefined,
        title: fastForwardTitle,
        onSelect: () => runIntegration({ action: "fastForward", branch: b }),
      },
      {
        id: "rebase",
        label: `Rebase ${cur} onto ${b}`,
        disabled: pending || gateTitle !== undefined,
        title: gateTitle,
        onSelect: () => runIntegration({ action: "rebase", onto: b }),
      },
    ];
  };

  /** `list` is unfiltered, so a filtered-out twin still counts as existing. */
  const menuItems = ({ target }: MenuState, list: BranchList): MenuItem[] => {
    const checkout: MenuItem = {
      id: "checkout",
      label: "Checkout",
      disabled: pending,
      onSelect: () => activate(target),
    };
    if (target.kind === "remote") {
      const { remote, name } = target.branch;
      const hasLocal = list.local.some((b) => b.name === name);
      return [
        {
          ...checkout,
          title: hasLocal ? undefined : `Creates a local branch tracking ${remote}/${name}`,
        },
        ...integrationItems(target, list.head),
        {
          id: "deleteRemote",
          label: `Delete on ${remote}…`,
          danger: true,
          disabled: pending,
          onSelect: () => openDialog({ kind: "deleteRemote", remote, name }),
        },
      ];
    }
    const { name, isHead } = target.branch;
    return [
      { ...checkout, disabled: pending || isHead },
      ...(isHead ? [] : integrationItems(target, list.head)),
      {
        id: "create",
        label: "Create branch here…",
        disabled: pending,
        onSelect: () => openDialog(createDialog(`New branch from ${name}`, name)),
      },
      {
        id: "rename",
        label: "Rename…",
        disabled: pending,
        onSelect: () => openDialog({ kind: "rename", name }),
      },
      {
        id: "delete",
        label: "Delete…",
        danger: true,
        disabled: pending || isHead,
        onSelect: () => openDialog({ kind: "deleteLocal", name }),
      },
    ];
  };

  const row = (target: BranchTarget, key: string, current: boolean) => (
    <BranchRow
      key={key}
      target={target}
      current={current}
      onActivate={() => activate(target)}
      onContextMenu={(x, y) => setMenu({ x, y, target })}
    />
  );

  const renderList = (list: BranchList) => {
    const shown = filterBranches(list, query);
    const filtered = shown !== list;
    const unborn = list.head.kind === "unborn";
    return (
      <>
        <div className={styles.toolbar}>
          <input
            type="search"
            className={styles.filter}
            aria-label="Filter branches"
            placeholder="Filter branches"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
          <button
            type="button"
            className={styles.newBranch}
            disabled={unborn || pending}
            title={unborn ? "Make a commit first" : undefined}
            onClick={() => openDialog(createDialog("New branch", null))}
          >
            New branch…
          </button>
        </div>
        {dialog === null && panelError !== null && (
          <RepoError error={panelError} path={null} onDismiss={clearErrors} />
        )}
        <BranchGroup
          heading="Local"
          listLabel="Local branches"
          filtered={filtered}
          count={shown.local.length}
          leading={headRow(list.head)}
        >
          {shown.local.map((branch) =>
            row({ kind: "local", branch }, `local:${branch.name}`, branch.isHead),
          )}
        </BranchGroup>
        {shown.remotes.map((group) => (
          <BranchGroup
            key={group.remote}
            heading={group.remote}
            listLabel={`${group.remote} branches`}
            filtered={filtered}
            count={group.branches.length}
          >
            {group.branches.map((branch) =>
              row({ kind: "remote", branch }, `${branch.remote}/${branch.name}`, false),
            )}
          </BranchGroup>
        ))}
        <ContextMenu
          open={menu !== null}
          x={menu?.x ?? 0}
          y={menu?.y ?? 0}
          items={menu === null ? [] : menuItems(menu, list)}
          onClose={closeMenu}
        />
      </>
    );
  };

  let body: React.ReactNode;
  if (listError !== null) {
    body = <RepoError error={listError} path={null} onRetry={refetch} onDismiss={refetch} />;
  } else if (branches === undefined) {
    body = <p role="status">Loading branches…</p>;
  } else {
    body = renderList(branches);
  }

  return (
    <section aria-label="Branches" aria-busy={pending || undefined} className={styles.root}>
      {body}
      {dialog?.kind === "create" && (
        <PromptDialog
          open
          title={dialog.title}
          label="Name"
          confirmLabel="Create"
          checkbox={{
            label: "Switch to new branch",
            checked: dialog.checkout,
            onChange: (checkout) => setDialog({ ...dialog, checkout }),
          }}
          error={actions.error}
          pending={actions.pending}
          onConfirm={(name) => void confirmCreate(dialog, name)}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === "rename" && (
        <PromptDialog
          open
          title={`Rename ${dialog.name}`}
          label="New name"
          initialValue={dialog.name}
          confirmLabel="Rename"
          error={actions.error}
          pending={actions.pending}
          onConfirm={(newName) => void confirmRename(dialog.name, newName)}
          onCancel={closeDialog}
        />
      )}
      {/* One element per confirm kind, so the delete to force-delete hand-off remounts the body
          and focus lands on the new dialog's Cancel. */}
      {dialog?.kind === "deleteLocal" && (
        <ConfirmDialog
          key="deleteLocal"
          open
          title={`Delete branch ${dialog.name}?`}
          body="The branch is merged into the current branch."
          confirmLabel="Delete"
          danger
          pending={actions.pending}
          onConfirm={() => void confirmDeleteLocal(dialog.name)}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === "forceDelete" && (
        <ConfirmDialog
          key="forceDelete"
          open
          title={`Force delete ${dialog.name}?`}
          body={`${dialog.name} has commits that are not merged into the current branch. Deleting it loses them unless another ref points at them.`}
          confirmLabel="Force delete"
          danger
          pending={actions.pending}
          onConfirm={() => void confirmForceDelete(dialog.name)}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === "deleteRemote" && (
        <ConfirmDialog
          key="deleteRemote"
          open
          title={`Delete ${dialog.remote}/${dialog.name} on ${dialog.remote}?`}
          body="This removes the branch from the remote for everyone."
          confirmLabel={`Delete on ${dialog.remote}`}
          danger
          pending={actions.pending}
          onConfirm={() => void confirmDeleteRemote(dialog.remote, dialog.name)}
          onCancel={closeDialog}
        />
      )}
    </section>
  );
}
