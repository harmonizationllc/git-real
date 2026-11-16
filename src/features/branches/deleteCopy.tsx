import type { ReactNode } from "react";
import type { AppError } from "../../lib/ipc";
import styles from "./BranchesPanel.module.css";

/** The branches a batch delete is about to remove, scrolling after ten. */
export function NameList({ names }: { names: string[] }) {
  return (
    <ul className={styles.nameList} aria-label="Branches">
      {names.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

interface DeleteCopy<L extends string> {
  title: string;
  body: ReactNode;
  confirmLabel: L;
}

const listed = (names: string[], text: string): ReactNode => (
  <>
    <NameList names={names} />
    {text}
  </>
);

export function localDeleteCopy(names: string[]): DeleteCopy<"Delete"> {
  if (names.length === 1) {
    return {
      title: `Delete branch ${names[0]}?`,
      body: "The branch is merged into the current branch.",
      confirmLabel: "Delete",
    };
  }
  return {
    title: `Delete ${names.length} branches?`,
    body: listed(names, "The branches are merged into the current branch."),
    confirmLabel: "Delete",
  };
}

export function forceDeleteCopy(names: string[]): DeleteCopy<"Force delete"> {
  if (names.length === 1) {
    return {
      title: `Force delete ${names[0]}?`,
      body: `${names[0]} has commits that are not merged into the current branch. Deleting it loses them unless another ref points at them.`,
      confirmLabel: "Force delete",
    };
  }
  return {
    title: `Force delete ${names.length} branches?`,
    body: listed(
      names,
      "These branches have commits that are not merged into the current branch. Deleting them loses those commits unless another ref points at them.",
    ),
    confirmLabel: "Force delete",
  };
}

export function remoteDeleteCopy(remote: string, names: string[]): DeleteCopy<string> {
  const confirmLabel = `Delete on ${remote}`;
  if (names.length === 1) {
    return {
      title: `Delete ${remote}/${names[0]} on ${remote}?`,
      body: "This removes the branch from the remote for everyone.",
      confirmLabel,
    };
  }
  return {
    title: `Delete ${names.length} branches on ${remote}?`,
    body: listed(names, "This removes the branches from the remote for everyone."),
    confirmLabel,
  };
}

export const deleteMenuLabel = (n: number): string =>
  n === 1 ? "Delete…" : `Delete ${n} branches…`;

export const remoteDeleteMenuLabel = (remote: string, n: number): string =>
  n === 1 ? `Delete on ${remote}…` : `Delete ${n} on ${remote}…`;

/** One toast for the branches a batch could not delete; a lone failure keeps its own error. */
export function failedDeleteToast(failed: { name: string; error: AppError }[]): AppError {
  if (failed.length === 1) return failed[0].error;
  const names = failed.map((f) => f.name).join(", ");
  return {
    kind: failed[0].error.kind,
    message: `Couldn't delete ${names}: ${failed[0].error.message}`,
  } as AppError;
}
