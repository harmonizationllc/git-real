import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { PromptDialog } from "../../components/PromptDialog";
import { copyText, toAppError } from "../../lib/ipc";
import type {
  AppError,
  GraphRow as GraphRowData,
  LogSummary,
  RepoId,
  ResetMode,
} from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { useBranchActions } from "../branches/useBranchActions";
import { useBranches } from "../branches/useBranches";
import { IN_PROGRESS_TITLE, headName } from "../merge/operationCopy";
import { RebaseDialog } from "../merge/rebase/RebaseDialog";
import { useIntegrationActions, type IntegrationRequest } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { RepoError } from "../repo/RepoError";
import { GraphRow } from "./GraphRow";
import { GraphToolbar } from "./GraphToolbar";
import { ROW_HEIGHT, SEARCH_DEBOUNCE_MS, shortOid } from "./model/layout";
import { pageOf, pageStart } from "./model/pages";
import { useCommitActions } from "./useCommitActions";
import { logPageOptions, useLogPages } from "./useLogPages";
import { logSearchOptions, useLogSearch } from "./useLogSearch";
import { useLogSummary } from "./useLogSummary";
import { useNow } from "./useNow";
import styles from "./GraphPanel.module.css";

export interface GraphPanelProps {
  repoId: RepoId;
}

interface MenuState {
  x: number;
  y: number;
  row: GraphRowData;
}

type Dialog =
  | { kind: "create"; oid: string; checkout: boolean }
  | { kind: "reset"; oid: string; mode: ResetMode }
  | { kind: "rebase"; oid: string };

type CreateDialog = Extract<Dialog, { kind: "create" }>;
type ResetDialog = Extract<Dialog, { kind: "reset" }>;

const RESET_MODES: { mode: ResetMode; label: string }[] = [
  { mode: "soft", label: "Soft — keep the index and working tree" },
  { mode: "mixed", label: "Mixed — keep the working tree, unstage everything" },
  { mode: "hard", label: "Hard — discard index and working tree changes" },
];

export function GraphPanel({ repoId }: GraphPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const { summary, error: summaryError, refetch } = useLogSummary(repoId);
  const { branches } = useBranches(repoId);
  const commitActions = useCommitActions(repoId);
  const branchActions = useBranchActions(repoId);
  const { state } = useOperationState(repoId);
  const integration = useIntegrationActions(repoId);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [copyError, setCopyError] = useState<AppError | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const modeName = useId();
  const pending = commitActions.pending || branchActions.pending || integration.pending;

  const clearErrors = () => {
    commitActions.clearError();
    branchActions.clearError();
    integration.clearError();
    setCopyError(null);
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

  const confirmCreate = async (d: CreateDialog, name: string) => {
    const err = await branchActions.run({
      action: "create",
      name,
      startPoint: d.oid,
      checkout: d.checkout,
    });
    if (err === null) closeDialog();
  };

  // The confirm dialog has no error slot: a failure closes it and shows in the panel.
  const confirmReset = async (d: ResetDialog) => {
    await commitActions.run({ action: "reset", oid: d.oid, mode: d.mode });
    setDialog(null);
  };

  const head = branches?.head;

  const menuItems = (row: GraphRowData): MenuItem[] => {
    const short = shortOid(row.oid);
    // The log marks the current branch's label and a detached HEAD label with `isHead`.
    const atHead = row.refs.some((r) => r.isHead);
    const blockTitle =
      state?.kind !== "none"
        ? IN_PROGRESS_TITLE
        : row.parents.length > 1
          ? "Merge commits are not supported yet"
          : undefined;
    const pickTitle = blockTitle ?? (atHead ? "Already on this commit" : undefined);
    // A merge commit is a fine base; the dialog reports a range that contains one.
    const rebaseTitle =
      state?.kind !== "none"
        ? IN_PROGRESS_TITLE
        : head?.kind !== "branch"
          ? "Check out a branch first"
          : atHead
            ? "Already at HEAD"
            : undefined;
    return [
      {
        id: "checkout",
        label: "Checkout",
        title: `Detaches HEAD at ${short}`,
        // A `head` label means HEAD is already detached at this commit.
        disabled: pending || row.refs.some((r) => r.kind === "head"),
        onSelect: () => void commitActions.run({ action: "checkout", oid: row.oid }),
      },
      {
        id: "create",
        label: "Create branch here…",
        disabled: pending,
        onSelect: () => openDialog({ kind: "create", oid: row.oid, checkout: true }),
      },
      {
        id: "reset",
        label: "Reset to this commit…",
        disabled: pending,
        onSelect: () => openDialog({ kind: "reset", oid: row.oid, mode: "mixed" }),
      },
      {
        id: "cherryPick",
        label: "Cherry-pick commit",
        disabled: pending || pickTitle !== undefined,
        title: pickTitle,
        onSelect: () => runIntegration({ action: "cherryPick", oid: row.oid }),
      },
      {
        id: "revert",
        label: "Revert commit",
        disabled: pending || blockTitle !== undefined,
        title: blockTitle,
        onSelect: () => runIntegration({ action: "revert", oid: row.oid }),
      },
      {
        id: "rebaseInteractive",
        label: "Rebase interactively from here…",
        disabled: pending || rebaseTitle !== undefined,
        title: rebaseTitle,
        onSelect: () => openDialog({ kind: "rebase", oid: row.oid }),
      },
      {
        id: "copy",
        label: "Copy hash",
        disabled: pending,
        onSelect: () => void copyText(row.oid).catch((e: unknown) => setCopyError(toAppError(e))),
      },
    ];
  };

  const movedRef = head === undefined || head.kind === "detached" ? "HEAD" : head.name;
  const panelError = commitActions.error ?? integration.error ?? copyError;

  let body: React.ReactNode;
  if (summaryError !== null) {
    body = <RepoError error={summaryError} path={null} onRetry={refetch} onDismiss={refetch} />;
  } else if (summary === undefined) {
    body = <p role="status">Loading history…</p>;
  } else if (summary.total === 0) {
    body = <p className={styles.empty}>No commits yet</p>;
  } else {
    body = (
      <CommitList
        repoId={repoId}
        summary={summary}
        onContextMenu={(x, y, row) => setMenu({ x, y, row })}
      />
    );
  }

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      data-focus-target
      aria-label="Commit graph"
      aria-busy={pending || undefined}
      className={styles.root}
    >
      {dialog === null && panelError !== null && (
        <RepoError error={panelError} path={null} onDismiss={clearErrors} />
      )}
      {body}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu.row)}
        onClose={closeMenu}
        fallbackFocus={rootRef}
      />
      {dialog?.kind === "rebase" && (
        <RebaseDialog
          repoId={repoId}
          base={dialog.oid}
          label={shortOid(dialog.oid)}
          head={headName(head)}
          run={integration.run}
          pending={integration.pending}
          onClose={closeDialog}
          fallbackFocus={rootRef}
        />
      )}
      {dialog?.kind === "create" && (
        <PromptDialog
          open
          title={`New branch from ${shortOid(dialog.oid)}`}
          label="Name"
          confirmLabel="Create"
          checkbox={{
            label: "Switch to new branch",
            checked: dialog.checkout,
            onChange: (checkout) => setDialog({ ...dialog, checkout }),
          }}
          error={branchActions.error}
          pending={pending}
          onConfirm={(name) => void confirmCreate(dialog, name)}
          onCancel={closeDialog}
          fallbackFocus={rootRef}
        />
      )}
      {dialog?.kind === "reset" && (
        <ConfirmDialog
          open
          title={`Reset to ${shortOid(dialog.oid)}?`}
          body={
            <>
              <fieldset className={styles.modes}>
                <legend>Mode</legend>
                {RESET_MODES.map(({ mode, label }) => (
                  <label key={mode} className={styles.mode}>
                    <input
                      type="radio"
                      name={modeName}
                      checked={dialog.mode === mode}
                      onChange={() => setDialog({ ...dialog, mode })}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <p>{`Moves ${movedRef} to ${shortOid(dialog.oid)}.`}</p>
            </>
          }
          confirmLabel="Reset"
          danger={dialog.mode === "hard"}
          pending={pending}
          onConfirm={() => void confirmReset(dialog)}
          onCancel={closeDialog}
          fallbackFocus={rootRef}
        />
      )}
    </section>
  );
}

// Module-level so the virtualizer's measurement cache is not rebuilt on every render.
const getItemKey = (index: number) => index;
const estimateSize = () => ROW_HEIGHT;

/** Swallows a rejection whose only consequence would be a missing scroll or selection. */
const ignore = () => undefined;

interface CommitListProps {
  repoId: RepoId;
  summary: LogSummary;
  onContextMenu(x: number, y: number, row: GraphRowData): void;
}

/** The search toolbar and the virtualized commit listbox of a non-empty history. */
function CommitList({ repoId, summary, onContextMenu }: CommitListProps) {
  const { generation, total, maxLanes } = summary;
  const queryClient = useQueryClient();
  const selectCommit = useWorkspace((s) => s.selectCommit);
  const selected = useWorkspace((s) => s.selectedCommit[repoId] ?? null);
  const idPrefix = useId();
  const rowId = (index: number) => `${idPrefix}-row-${index}`;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Relative dates are computed against this clock rather than reading it during render.
  const now = useNow();

  // No React Compiler is installed, so nothing memoizes the virtualizer's functions anyway.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 20,
    getItemKey,
  });
  const items = virtualizer.getVirtualItems();
  const indices = items.map((item) => item.index);
  // An empty window gives Infinity..-Infinity, which useLogPages reads as no pages.
  const pages = useLogPages(repoId, generation, Math.min(...indices), Math.max(...indices));
  const rendered = items.map((item) => ({ item, row: pages.rowAt(item.index) }));
  // An empty window (the real virtualizer before it measures) has not shown anything yet.
  const settled = rendered.length > 0 && rendered.every(({ row }) => row !== undefined);
  const selectedIndex = rendered.find(({ row }) => row?.oid === selected)?.item.index;

  // The oid the panel already scrolled to (or found rendered); never reset by a new generation.
  const revealed = useRef<string | null>(null);
  // Index of the last row the panel selected or revealed; the keyboard's anchor when the
  // selection is not rendered.
  const lastIndex = useRef(-1);
  // Latest-wins sequencing for selections that wait on a page fetch.
  const seq = useRef(0);
  // Async continuations (page fetches, searches) must not scroll or select after an unmount.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pick = (index: number, oid: string) => {
    seq.current += 1;
    lastIndex.current = index;
    revealed.current = oid;
    selectCommit(repoId, oid);
  };

  /** Scrolls to and selects row `index`, fetching its page first when it is not loaded. */
  const selectIndex = (index: number, align?: "center") => {
    if (align) virtualizer.scrollToIndex(index, { align });
    else virtualizer.scrollToIndex(index);
    const row = pages.rowAt(index);
    if (row) {
      pick(index, row.oid);
      return;
    }
    const n = ++seq.current;
    const page = pageOf(index);
    queryClient
      .fetchQuery(logPageOptions(repoId, generation, page))
      .then(({ rows }) => {
        const found = rows[index - pageStart(page)];
        if (mounted.current && n === seq.current && found) pick(index, found.oid);
      })
      .catch(ignore);
  };

  // Reveal: a selection made elsewhere (the summary's parent links, a search) whose row is
  // not rendered is located through searchLog, verified against its page row, and centred.
  useEffect(() => {
    if (!settled || selected === revealed.current) return;
    revealed.current = selected;
    if (selected === null || selectedIndex !== undefined) return;
    const oid = selected;
    const stillSelected = () =>
      mounted.current && useWorkspace.getState().selectedCommit[repoId] === oid;
    const reveal = async () => {
      // A revert or cherry-pick message contains the full oid too, so verify each candidate.
      const candidates = await queryClient.fetchQuery(logSearchOptions(repoId, generation, oid));
      for (const index of candidates) {
        const page = pageOf(index);
        const { rows } = await queryClient.fetchQuery(logPageOptions(repoId, generation, page));
        if (!stillSelected()) return;
        if (rows[index - pageStart(page)]?.oid === oid) {
          lastIndex.current = index;
          virtualizer.scrollToIndex(index, { align: "center" });
          return;
        }
      }
    };
    reveal().catch(ignore);
  }, [settled, selected, selectedIndex, repoId, generation, queryClient, virtualizer]);

  // Search: the input is debounced into the query that is searched. The debounce also starts
  // the fetch and reveals the first match when it answers, so the reveal happens once per
  // query and never again when a new generation re-runs the same search.
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const searched = useRef("");
  // The cursor belongs to a query, so a new query starts at its first match while a new
  // generation of the same query keeps the position when the match count allows.
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const clearSearch = () => {
    searched.current = "";
    setQuery("");
  };
  const search = useEffectEvent((q: string) => {
    if (q === "") {
      clearSearch();
      return;
    }
    searched.current = q;
    setQuery(q);
    // Every submission starts at the first match, even a retyped query.
    setCursor({ query: q, index: 0 });
    queryClient
      .fetchQuery(logSearchOptions(repoId, generation, q))
      .then((found) => {
        if (mounted.current && searched.current === q && found.length > 0) {
          selectIndex(found[0], "center");
        }
      })
      .catch(ignore);
  });
  useEffect(() => {
    const timer = setTimeout(() => search(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);
  const { matches, isFetching } = useLogSearch(repoId, generation, query);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const current =
    cursor.query === query ? Math.min(cursor.index, Math.max(matches.length - 1, 0)) : 0;

  const step = (delta: number) => {
    const n = matches.length;
    if (n === 0) return;
    const index = (current + delta + n) % n;
    setCursor({ query, index });
    selectIndex(matches[index], "center");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      // Without this WebKit also fires a native contextmenu, opening the menu twice.
      e.preventDefault();
      if (selectedIndex === undefined) return;
      const r = (
        document.getElementById(rowId(selectedIndex)) as HTMLElement
      ).getBoundingClientRect();
      onContextMenu(r.left, r.bottom, pages.rowAt(selectedIndex) as GraphRowData);
      return;
    }
    // -1 makes ArrowDown, ArrowUp and Enter start at row 0 when nothing is selected.
    const at = selected === null ? -1 : (selectedIndex ?? lastIndex.current);
    let target: number;
    switch (e.key) {
      case "ArrowDown":
        target = Math.min(at + 1, total - 1);
        break;
      case "ArrowUp":
        target = Math.max(at - 1, 0);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = total - 1;
        break;
      case "Enter":
        // Enter only matters with nothing selected; the selected row is already active.
        e.preventDefault();
        if (selected === null) selectIndex(0);
        return;
      default:
        return;
    }
    // The scroll container would otherwise scroll natively as well.
    e.preventDefault();
    selectIndex(target);
  };

  return (
    <>
      <GraphToolbar
        query={input}
        onQueryChange={(value) => {
          setInput(value);
          // Clearing is immediate; typing waits for the debounce.
          if (value === "") clearSearch();
        }}
        matchCount={query === "" || isFetching ? null : matches.length}
        current={current}
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      />
      {pages.error !== null && (
        <RepoError
          error={pages.error}
          path={null}
          onRetry={pages.refetch}
          onDismiss={pages.refetch}
        />
      )}
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Commits"
        tabIndex={0}
        aria-activedescendant={selectedIndex === undefined ? undefined : rowId(selectedIndex)}
        className={styles.list}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          role="presentation"
          className={styles.inner}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {rendered.map(({ item, row }) => (
            <div
              key={item.key}
              role="presentation"
              className={styles.item}
              style={{ transform: `translateY(${item.start}px)`, height: item.size }}
            >
              {row ? (
                <GraphRow
                  row={row}
                  now={now}
                  maxLanes={maxLanes}
                  selected={row.oid === selected}
                  matched={matchSet.has(item.index)}
                  id={rowId(item.index)}
                  onSelect={() => pick(item.index, row.oid)}
                  onContextMenu={(x, y) => {
                    pick(item.index, row.oid);
                    onContextMenu(x, y, row);
                  }}
                />
              ) : (
                // Hidden from assistive technology: "…" carries nothing to announce, and the
                // listbox then exposes only real commits.
                <div
                  role="option"
                  aria-selected={false}
                  aria-busy="true"
                  aria-hidden="true"
                  className={styles.placeholder}
                >
                  …
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
