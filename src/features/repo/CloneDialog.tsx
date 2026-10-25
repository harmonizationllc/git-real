import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { checkGitCli, onCloneProgress, pickFolder } from "../../lib/ipc";
import type { HostedRepo, Progress, UnlistenFn } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import { AccountsDialog } from "../hosting/AccountsDialog";
import type { AccountsPreset } from "../hosting/AccountsDialog";
import { cloneUrlFor } from "../hosting/cloneUrlFor";
import { RepoBrowser } from "../hosting/RepoBrowser";
import { useSettings } from "../settings/useSettings";
import styles from "./CloneDialog.module.css";
import { CloneSourceTabs, cloneSourceIds } from "./CloneSourceTabs";
import type { CloneSource } from "./CloneSourceTabs";
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
  const { settings } = useSettings();
  const [url, setUrl] = useState("");
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const subRef = useRef<Promise<UnlistenFn | undefined> | null>(null);
  const [tab, setTab] = useState<CloneSource>("url");
  // The repository the URL came from, until the user edits the field.
  const [picked, setPicked] = useState<HostedRepo | null>(null);
  // The browser's account, kept here so it survives the browser unmounting on a tab switch.
  const [accountId, setAccountId] = useState<string | null>(null);
  const form = useLayoutPrefs((s) => s.cloneUrlForm);
  const [prevForm, setPrevForm] = useState(form);
  // The accounts dialog is open (with its optional preset) when this is not null.
  const [accounts, setAccounts] = useState<{ preset?: AccountsPreset } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const accountTabRef = useRef<HTMLButtonElement>(null);
  // The URL field takes focus once it shows: on open, and after a pick.
  const focusUrl = useRef(true);
  // The element that opened the accounts dialog, and whether the dialog was open at the last
  // commit. The dialog's own restore runs while this box is still inert, so it cannot land.
  const accountsOpener = useRef<HTMLElement | null>(null);
  const accountsWereOpen = useRef(false);

  useEffect(() => () => releaseSubscription(subRef), []);

  // Seed the destination from the configured default clone directory the first time it is known,
  // and only while the user has not chosen one; a later-arriving setting never overwrites a folder
  // they already picked. Done during render (not an effect) so the preview is right on first paint.
  const defaultCloneDir = settings?.defaultCloneDir ?? null;
  const [seededDefault, setSeededDefault] = useState(false);
  if (!seededDefault && defaultCloneDir !== null) {
    setSeededDefault(true);
    if (parentDir === null) setParentDir(defaultCloneDir);
  }
  useLayoutEffect(() => {
    if (focusUrl.current && urlInputRef.current !== null) {
      urlInputRef.current.focus();
      focusUrl.current = false;
    }
    // After the commit that closed the accounts dialog, inert is gone: back to the opener while it
    // is still in this box, else to the From account tab (connecting an account removes the
    // notice; an opener recorded as the body was never in the box).
    if (accountsWereOpen.current && accounts === null) {
      const opener = accountsOpener.current;
      const box = boxRef.current as HTMLDivElement;
      const usable =
        opener !== null &&
        box.contains(opener) &&
        // Defensive: no opener can be disabled while the box is inert.
        !opener.matches(":disabled");
      (usable ? opener : (accountTabRef.current as HTMLButtonElement)).focus();
    }
    accountsWereOpen.current = accounts !== null;
  });

  // A changed HTTPS/SSH preference re-fills the field for the picked repository.
  if (form !== prevForm) {
    setPrevForm(form);
    if (picked !== null) setUrl(cloneUrlFor(picked, form).url);
  }

  const name = repoNameFromUrl(url);
  const dest = parentDir !== null && name !== null ? joinDest(parentDir, name) : null;
  const canClone = dest !== null && !cloning;

  const choose = async () => {
    // Pass the current directory only when there is one, so the picker opens there.
    const picked =
      parentDir !== null
        ? await pickFolder("Choose destination folder", parentDir)
        : await pickFolder("Choose destination folder");
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
    // An Escape that cancels an IME composition in any field belongs to the composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && !cloning) onClose();
  };

  const pick = (repo: HostedRepo) => {
    setPicked(repo);
    setUrl(cloneUrlFor(repo, form).url);
    setTab("url");
    focusUrl.current = true;
  };

  const gitMissing = git.data?.available === false;

  return (
    <>
      <div className={styles.backdrop}>
        <div
          role="dialog"
          aria-modal="true"
          ref={boxRef}
          aria-labelledby={headingId}
          className={styles.dialog}
          inert={accounts !== null}
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
              <CloneSourceTabs
                idBase={headingId}
                selected={tab}
                onSelect={setTab}
                disabled={cloning}
                accountTabRef={accountTabRef}
              />
              <div
                role="tabpanel"
                id={cloneSourceIds(headingId, "url").panel}
                aria-labelledby={cloneSourceIds(headingId, "url").tab}
                hidden={tab !== "url"}
              >
                {tab === "url" && (
                  <div className={styles.field}>
                    <label htmlFor={`${headingId}-url`}>Repository URL</label>
                    <input
                      ref={urlInputRef}
                      id={`${headingId}-url`}
                      type="text"
                      value={url}
                      placeholder="https://github.com/owner/repo.git"
                      aria-describedby={`${headingId}-url-hint`}
                      disabled={cloning}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setPicked(null);
                      }}
                    />
                  </div>
                )}
              </div>
              {/* Always mounted and never hidden, so a screen reader announces the hint when its
                  text appears; it shows under the URL field because the other panel is hidden. */}
              <p role="status" id={`${headingId}-url-hint`} className={styles.hint}>
                {tab === "url" &&
                  picked !== null &&
                  cloneUrlFor(picked, form).fellBack &&
                  "This repository has no SSH URL; HTTPS was used"}
              </p>
              <div
                role="tabpanel"
                id={cloneSourceIds(headingId, "account").panel}
                aria-labelledby={cloneSourceIds(headingId, "account").tab}
                hidden={tab !== "account"}
              >
                {tab === "account" && (
                  <RepoBrowser
                    onPick={pick}
                    onManageAccounts={(preset) => {
                      accountsOpener.current = document.activeElement as HTMLElement | null;
                      setAccounts({ preset });
                    }}
                    disabled={cloning}
                    selectedAccountId={accountId}
                    onSelectAccount={setAccountId}
                  />
                )}
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
      <AccountsDialog
        open={accounts !== null}
        preset={accounts?.preset}
        onClose={() => setAccounts(null)}
        fallbackFocus={accountTabRef}
      />
    </>
  );
}
