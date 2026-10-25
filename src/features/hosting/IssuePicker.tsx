import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import type { HostingProvider, RepoId } from "../../lib/ipc";
import { NetworkError } from "../remotes/NetworkError";
import { ISSUES_OFF_TEXT, hostingMessage } from "./hostingCopy";
import styles from "./IssuePicker.module.css";
import { useIssues } from "./useIssues";
import { issuesAllowed, useRepoInfo } from "./useRepoInfo";

/** How long typing must pause before the query reaches the provider. */
const DEBOUNCE_MS = 300;

/** How far each navigation key moves the active option; Enter (0) picks it. */
const STEPS: Partial<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1, Enter: 0 };

export interface IssuePickerProps {
  repoId: RepoId;
  provider: HostingProvider;
  onPick(number: number): void;
  onClose(): void;
  /**
   * An element outside the popover (the # button) whose pointerdown or focus does not close it,
   * so the click on it can toggle the picker from the parent.
   */
  ignore?: RefObject<HTMLElement | null>;
}

/**
 * A non-modal popover that searches the open issues (first page only) and returns the chosen
 * issue's number. It closes on Escape, a pointerdown outside it, or focus leaving it, because an
 * open dialog switches off every window shortcut.
 */
export function IssuePicker({ repoId, provider, onPick, onClose, ignore }: IssuePickerProps) {
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const repoInfo = useRepoInfo(repoId, true);
  const info = repoInfo.info;
  // No issues call before the repository info answers; a failed info falls back to asking
  // unless it was the token or the rate limit.
  const allowed = issuesAllowed(info, repoInfo.error);
  const list = useIssues(repoId, debounced, allowed);

  // Off while React tears the popover down, StrictMode's simulated unmount included. Declared
  // before useRestoreFocus so its cleanup runs first, and the blur that the focus restore causes
  // is not read as focus leaving.
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Before the focus effect, so it records the opener.
  useRestoreFocus();
  useLayoutEffect(() => {
    (inputRef.current as HTMLInputElement).focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query.trim());
      setActive(0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // The latest onClose and ignore, so the document listener is added once.
  const closeRef = useRef(onClose);
  const ignoreRef = useRef(ignore);
  useLayoutEffect(() => {
    closeRef.current = onClose;
    ignoreRef.current = ignore;
  });
  // Read only from event handlers: inside the popover or the ignored element.
  const isInside = (node: Node) =>
    (rootRef.current as HTMLDivElement).contains(node) ||
    ignoreRef.current?.current?.contains(node) === true;
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!isInside(e.target as Node)) closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const off = info?.issuesEnabled === false;
  const issues = off ? undefined : list.issues;
  const results = issues ?? [];
  // A new answer can shrink the list under the active row, so every use reads the clamped index.
  const current = Math.min(active, results.length - 1);

  const move = (index: number) => {
    setActive(index);
    (document.getElementById(optionId(index)) as HTMLElement).scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // An Escape that cancels an IME composition belongs to the composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") onClose();
  };

  const onInputKeyDown = (e: KeyboardEvent) => {
    // A key that confirms an IME composition belongs to the composition, not to the list.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Escape clears a search first; on an empty one it reaches the wrapper, which closes.
    if (e.key === "Escape" && query !== "") {
      setQuery("");
      e.stopPropagation();
      return;
    }
    const step = STEPS[e.key];
    if (step === undefined) return;
    // The input would otherwise move its caret, and there is no form to submit.
    e.preventDefault();
    if (results.length === 0) return;
    if (step === 0) onPick((results[current] as (typeof results)[number]).number);
    // The ends clamp rather than wrap.
    else move(Math.min(Math.max(current + step, 0), results.length - 1));
  };

  // Clicking an option does not take focus, so a null relatedTarget is not "focus left".
  const onBlur = (e: FocusEvent) => {
    const next = e.relatedTarget;
    if (live.current && next !== null && !isInside(next)) {
      onClose();
    }
  };

  let body: React.ReactNode = null;
  if (off) {
    body = <p className={styles.empty}>{ISSUES_OFF_TEXT}</p>;
  } else if (info === undefined && repoInfo.error !== null && !allowed) {
    // The repository info failed in a way a search would only repeat, so it stands in for it.
    body = (
      <NetworkError
        message={hostingMessage(repoInfo.error, provider)}
        onDismiss={repoInfo.refetch}
      />
    );
  } else if (list.error !== null && issues === undefined) {
    body = <NetworkError message={hostingMessage(list.error, provider)} onDismiss={list.refetch} />;
  } else if (issues === undefined) {
    body = <p role="status">Searching…</p>;
  } else if (issues.length === 0) {
    body = <p className={styles.empty}>No open issues match</p>;
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Link issue"
      className={styles.root}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <input
        ref={inputRef}
        type="search"
        aria-label="Search issues"
        placeholder="Type to search"
        aria-controls={listId}
        aria-activedescendant={results.length > 0 ? optionId(current) : undefined}
        value={query}
        spellCheck={false}
        autoComplete="off"
        className={styles.search}
        onKeyDown={onInputKeyDown}
        onChange={(e) => setQuery(e.target.value)}
      />
      {body}
      <ul id={listId} role="listbox" aria-label="Issues" className={styles.list}>
        {results.map((issue, index) => (
          <li
            key={issue.number}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            className={styles.option}
            onClick={() => onPick(issue.number)}
          >
            <span className={styles.number}>#{issue.number}</span> {issue.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
