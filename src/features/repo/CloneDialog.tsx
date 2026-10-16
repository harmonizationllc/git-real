import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { checkGitCli, onCloneProgress, pickFolder } from "../../lib/ipc";
import type { Progress, UnlistenFn } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import styles from "./CloneDialog.module.css";
import { repoNameFromUrl } from "./repoNameFromUrl";
import { RepoError } from "./RepoError";
import { useOpenRepo } from "./useOpenRepo";

export interface CloneDialogProps {
  open: boolean;
  onClose(): void;
}

type Subscription = { current: Promise<UnlistenFn | undefined> | null };

function releaseSubscription(ref: Subscription): void {
  const sub = ref.current;
  ref.current = null;
  void sub?.then((unlisten) => unlisten?.());
}

function joinDest(parentDir: string, name: string): string {
  return `${parentDir.replace(/[\\/]+$/, "")}/${name}`;
}

export function CloneDialog({ open, onClose }: CloneDialogProps) {
  return open ? <CloneDialogBody onClose={onClose} /> : null;
}

function CloneDialogBody({ onClose }: { onClose(): void }) {
  const headingId = useId();
  const git = useQuery({ queryKey: queryKeys.gitCli, queryFn: () => checkGitCli() });
  const { clone, error, clearError } = useOpenRepo();
  const [url, setUrl] = useState("");
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const subRef = useRef<Promise<UnlistenFn | undefined> | null>(null);

  useEffect(() => () => releaseSubscription(subRef), []);

  const name = repoNameFromUrl(url);
  const dest = parentDir !== null && name !== null ? joinDest(parentDir, name) : null;
  const canClone = dest !== null && !cloning;

  const choose = async () => {
    const picked = await pickFolder("Choose destination folder");
    if (picked !== null) setParentDir(picked);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canClone) return;
    const cloneId = Date.now();
    clearError();
    setProgress(null);
    setCloning(true);
    const sub = onCloneProgress(cloneId, setProgress).catch(() => undefined);
    subRef.current = sub;
    await sub;
    const ok = await clone(url.trim(), dest, cloneId);
    releaseSubscription(subRef);
    if (ok) onClose();
    else setCloning(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !cloning) onClose();
  };

  const gitMissing = git.data?.available === false;

  return (
    <div className={styles.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id={headingId} className={styles.title}>
          Clone repository
        </h2>
        {git.isPending ? (
          <p role="status">Checking for Git…</p>
        ) : gitMissing ? (
          <>
            <p>Git was not found on your PATH. Install Git to clone repositories.</p>
            <div className={styles.actions}>
              <button type="button" onClick={onClose} autoFocus>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className={styles.form}>
            <div className={styles.field}>
              <label htmlFor={`${headingId}-url`}>Repository URL</label>
              <input
                id={`${headingId}-url`}
                type="text"
                value={url}
                placeholder="https://github.com/owner/repo.git"
                disabled={cloning}
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <button type="button" disabled={cloning} onClick={choose}>
                Choose folder
              </button>
              {dest !== null && <p className={styles.destination}>{`Destination: ${dest}`}</p>}
            </div>
            {cloning && (
              <div className={styles.field}>
                <progress
                  className={styles.progress}
                  aria-label="Clone progress"
                  max={100}
                  value={progress?.percent ?? undefined}
                />
                <p>{progress?.message ?? "Starting clone…"}</p>
              </div>
            )}
            {error !== null && <RepoError error={error} path={null} onDismiss={clearError} />}
            <div className={styles.actions}>
              <button type="button" disabled={cloning} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" disabled={!canClone}>
                Clone
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
