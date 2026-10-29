import { useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { PromptDialog } from "../../components/PromptDialog";
import { deleteRemoteBranch } from "../../lib/ipc";
import type { AppError, BranchList, HeadState, RepoId, WorktreeBranch } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { AddWorktreeDialog } from "../linkedWorktrees/AddWorktreeDialog";
import { folderName } from "../linkedWorktrees/worktreePath";
import { IN_PROGRESS_TITLE, headName } from "../merge/operationCopy";
import { RebaseDialog } from "../merge/rebase/RebaseDialog";
import { useCanFastForward } from "../merge/useCanFastForward";
import { useIntegrationActions, type IntegrationRequest } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { CredentialDialog } from "../remotes/CredentialDialog";
import { NetworkError } from "../remotes/NetworkError";
import { networkMessage } from "../remotes/networkMessage";
import { removeRemoteCopy } from "../remotes/remoteCopy";
import type { RemotesTarget } from "../remotes/remotesTarget";
import { useNetworkAction } from "../remotes/useNetworkAction";
import { useRemoteActions } from "../remotes/useRemoteActions";
import { RepoError } from "../repo/RepoError";
import { useOpenRepo } from "../repo/useOpenRepo";
import { BranchGroup } from "./BranchGroup";
import { BranchRow, branchId, type BranchDrag, type BranchTarget } from "./BranchRow";
import styles from "./BranchesPanel.module.css";
import { filterBranches } from "./branchFilter";
import { useBranchActions } from "./useBranchActions";
import { useBranches } from "./useBranches";

export interface BranchesPanelProps {
  repoId: RepoId;
  /** Opens the remotes dialog; without it a remote heading's Edit remote… is disabled. */
  onOpenRemotes?(target: RemotesTarget): void;
  /** Opens the create pull request dialog from the current branch; null or absent hides it. */
  onCreatePullRequest?: (() => void) | null;
}

interface MenuState {
  x: number;
  y: number;
  target: BranchTarget;
  /** Opened by a drop on the current branch: the integration items alone. */
  dropMenu?: boolean;
}

/** The context menu of a remote group's heading. */
interface HeadingMenuState {
  x: number;
  y: number;
  remote: string;
}

type Dialog =
  | { kind: "create"; title: string; startPoint: string | null; checkout: boolean }
  | { kind: "rename"; name: string }
  | { kind: "deleteLocal"; name: string }
  | { kind: "forceDelete"; name: string }
  | { kind: "deleteRemote"; remote: string; name: string }
  | { kind: "removeRemote"; name: string }
  | { kind: "rebase"; base: string }
  | { kind: "worktree"; initial: WorktreeBranch };

type CreateDialog = Extract<Dialog, { kind: "create" }>;

const createDialog = (title: string, startPoint: string | null): CreateDialog => ({
  kind: "create",
  title,
  startPoint,
  checkout: true,
});

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

export function BranchesPanel({ repoId, onOpenRemotes, onCreatePullRequest }: BranchesPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const { branches, error: listError, refetch } = useBranches(repoId);
  const actions = useBranchActions(repoId);
  const { state } = useOperationState(repoId);
  const integration = useIntegrationActions(repoId);
  const network = useNetworkAction(repoId);
  const remoteActions = useRemoteActions(repoId);
  // The last remote delete or remove failure; those actions resolve it rather than holding it.
  const [remoteError, setRemoteError] = useState<AppError | null>(null);
  const pending =
    actions.pending || integration.pending || network.pending || remoteActions.pending;
  const opener = useOpenRepo();
  const panelError = actions.error ?? integration.error ?? remoteError ?? opener.error;
  const query = useWorkspace((s) => s.refsFilter[repoId] ?? "");
  const setQuery = (text: string) => useWorkspace.getState().setRefsFilter(repoId, text);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Drag-to-merge: the branch being dragged, and how deep the pointer is inside the current
  // branch's row (dragenter and dragleave also fire for its children).
  const [dragging, setDragging] = useState<BranchTarget | null>(null);
  const [overDepth, setOverDepth] = useState(0);
  const [headingMenu, setHeadingMenu] = useState<HeadingMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeHeadingMenu = useCallback(() => setHeadingMenu(null), []);
  const menuBranch =
    menu === null || (menu.target.kind === "local" && menu.target.branch.isHead)
      ? null
      : branchId(menu.target);
  const ff = useCanFastForward(repoId, menuBranch);

  const clearErrors = () => {
    actions.clearError();
    integration.clearError();
    setRemoteError(null);
    opener.clearError();
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

  // Through the network gate: the confirm stays open (pending) during a sign-in and its retry.
  const confirmDeleteRemote = async (remote: string, name: string) => {
    const result = await network.run((c) => deleteRemoteBranch(repoId, remote, name, c));
    setDialog(null);
    if (result.status === "failed") setRemoteError(result.error);
  };

  const confirmRemoveRemote = async (name: string) => {
    const error = await remoteActions.remove(name);
    setDialog(null);
    setRemoteError(error);
  };

  const headingItems = (remote: string): MenuItem[] => [
    {
      id: "editRemote",
      label: "Edit remote…",
      disabled: onOpenRemotes === undefined,
      // A disabled item cannot be selected, so onOpenRemotes is set here.
      onSelect: () => (onOpenRemotes as (t: RemotesTarget) => void)({ mode: "edit", name: remote }),
    },
    {
      id: "removeRemote",
      label: "Remove remote…",
      danger: true,
      disabled: pending,
      onSelect: () => openDialog({ kind: "removeRemote", name: remote }),
    },
  ];

  /** Why the current branch cannot integrate another one right now, if it cannot. */
  const integrationGate = (head: HeadState): string | undefined =>
    state?.kind !== "none"
      ? IN_PROGRESS_TITLE
      : head.kind !== "branch"
        ? "Check out a branch first"
        : undefined;

  /** Merge, fast-forward and rebase of the current branch with the row's branch. */
  const integrationItems = (target: BranchTarget, head: HeadState): MenuItem[] => {
    const b = branchId(target);
    const cur = headName(head);
    const gateTitle = integrationGate(head);
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

  /** The integration items plus the interactive rebase onto the row's branch. */
  const rebaseItems = (target: BranchTarget, head: HeadState): MenuItem[] => {
    const b = branchId(target);
    const gateTitle = integrationGate(head);
    return [
      ...integrationItems(target, head),
      {
        id: "rebaseInteractive",
        label: `Rebase ${headName(head)} onto ${b} interactively…`,
        disabled: pending || gateTitle !== undefined,
        title: gateTitle,
        onSelect: () => openDialog({ kind: "rebase", base: b }),
      },
    ];
  };

  /** `list` is unfiltered, so a filtered-out twin still counts as existing. */
  const menuItems = ({ target, dropMenu }: MenuState, list: BranchList): MenuItem[] => {
    if (dropMenu) return integrationItems(target, list.head);
    // A remote row acts on its local twin when one exists, so the twin's worktree locks it too.
    const twin =
      target.kind === "remote" ? list.local.find((b) => b.name === target.branch.name) : undefined;
    const elsewhere = target.kind === "local" ? target.branch.worktree : (twin?.worktree ?? null);
    const lockedTitle =
      elsewhere === null ? undefined : `Checked out in worktree ${folderName(elsewhere)}`;
    const checkout: MenuItem = {
      id: "checkout",
      label: "Checkout",
      disabled: pending || elsewhere !== null,
      title: lockedTitle,
      onSelect: () => activate(target),
    };
    if (target.kind === "remote") {
      const { remote, name } = target.branch;
      const worktreeTitle = twin?.isHead ? "Already checked out in this worktree" : lockedTitle;
      return [
        {
          ...checkout,
          title:
            twin === undefined ? `Creates a local branch tracking ${remote}/${name}` : lockedTitle,
        },
        {
          id: "worktree",
          label: "Create worktree…",
          disabled: pending || worktreeTitle !== undefined,
          title: worktreeTitle,
          onSelect: () =>
            openDialog({
              kind: "worktree",
              initial:
                twin === undefined
                  ? { kind: "new", name, start: `${remote}/${name}` }
                  : { kind: "existing", name },
            }),
        },
        ...rebaseItems(target, list.head),
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
      { ...checkout, disabled: pending || isHead || elsewhere !== null },
      ...(isHead && onCreatePullRequest
        ? [{ id: "createPr", label: "Create pull request…", onSelect: onCreatePullRequest }]
        : []),
      ...(isHead ? [] : rebaseItems(target, list.head)),
      {
        id: "create",
        label: "Create branch here…",
        disabled: pending,
        onSelect: () => openDialog(createDialog(`New branch from ${name}`, name)),
      },
      {
        id: "worktree",
        label: "Create worktree…",
        disabled: pending || elsewhere !== null,
        title: lockedTitle,
        onSelect: () => openDialog({ kind: "worktree", initial: { kind: "existing", name } }),
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
        disabled: pending || isHead || elsewhere !== null,
        title: lockedTitle,
        onSelect: () => openDialog({ kind: "deleteLocal", name }),
      },
    ];
  };

  const endDrag = () => {
    setDragging(null);
    setOverDepth(0);
  };

  /** Any other branch can be dragged onto the current one while the repository is idle. */
  const branchDrag = (target: BranchTarget, current: boolean, canDrag: boolean): BranchDrag => ({
    draggable: canDrag && !current,
    target: current && dragging !== null,
    over: current && overDepth > 0,
    onDragStart: () => setDragging(target),
    onDragEnd: endDrag,
    onDragEnter: () => setOverDepth((d) => d + 1),
    onDragLeave: () => setOverDepth((d) => Math.max(0, d - 1)),
    onDrop: (x, y) => {
      // The row reports a drop only while it is a target, which requires a dragged branch.
      setMenu({ x, y, target: dragging as BranchTarget, dropMenu: true });
      endDrag();
    },
  });

  const renderList = (list: BranchList) => {
    const canDrag = state?.kind === "none" && list.head.kind === "branch" && !pending;
    const row = (target: BranchTarget, key: string, current: boolean) => (
      <BranchRow
        key={key}
        target={target}
        current={current}
        drag={branchDrag(target, current, canDrag)}
        onActivate={() => activate(target)}
        onContextMenu={(x, y) => setMenu({ x, y, target })}
      />
    );
    const shown = filterBranches(list, query);
    const filtered = shown !== list;
    const unborn = list.head.kind === "unborn";
    return (
      <>
        <div className={styles.toolbar}>
          <input
            type="search"
            className={styles.filter}
            aria-label="Filter branches and tags"
            placeholder="Filter branches and tags"
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
        {dialog === null &&
          panelError !== null &&
          (panelError.kind === "networkFailed" ? (
            <NetworkError message={networkMessage(panelError)} onDismiss={clearErrors} />
          ) : (
            <RepoError error={panelError} path={null} variant="panel" onDismiss={clearErrors} />
          ))}
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
            onHeadingContextMenu={(x, y) => setHeadingMenu({ x, y, remote: group.remote })}
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
          fallbackFocus={rootRef}
        />
        <ContextMenu
          open={headingMenu !== null}
          x={headingMenu?.x ?? 0}
          y={headingMenu?.y ?? 0}
          items={headingMenu === null ? [] : headingItems(headingMenu.remote)}
          onClose={closeHeadingMenu}
          fallbackFocus={rootRef}
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
    <section
      ref={rootRef}
      tabIndex={-1}
      data-focus-target
      aria-label="Branches"
      aria-busy={pending || undefined}
      className={styles.root}
    >
      {body}
      {dialog?.kind === "rebase" && (
        <RebaseDialog
          repoId={repoId}
          base={dialog.base}
          label={dialog.base}
          head={headName(branches?.head)}
          run={integration.run}
          pending={integration.pending}
          onClose={closeDialog}
          fallbackFocus={rootRef}
        />
      )}
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
          fallbackFocus={rootRef}
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
          fallbackFocus={rootRef}
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
          fallbackFocus={rootRef}
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
          fallbackFocus={rootRef}
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
          pending={network.pending}
          onConfirm={() => void confirmDeleteRemote(dialog.remote, dialog.name)}
          onCancel={closeDialog}
          fallbackFocus={rootRef}
        />
      )}
      {dialog?.kind === "removeRemote" && (
        <ConfirmDialog
          key="removeRemote"
          open
          {...removeRemoteCopy(dialog.name)}
          confirmLabel="Remove"
          danger
          pending={remoteActions.pending}
          onConfirm={() => void confirmRemoveRemote(dialog.name)}
          onCancel={closeDialog}
          fallbackFocus={rootRef}
        />
      )}
      {dialog?.kind === "worktree" && (
        <AddWorktreeDialog
          repoId={repoId}
          open
          initial={dialog.initial}
          onClose={closeDialog}
          onAdded={(path) => void opener.open(path)}
          fallbackFocus={rootRef}
        />
      )}
      {/* Last, so a sign-in asked for during the remote delete paints above its confirm. */}
      <CredentialDialog prompt={network.prompt} fallbackFocus={rootRef} />
    </section>
  );
}
