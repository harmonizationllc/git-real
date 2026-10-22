import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { fetchRemote } from "../../lib/ipc";
import type { AppError, RemoteInfo, RepoId } from "../../lib/ipc";
import { RepoError } from "../repo/RepoError";
import { CredentialDialog } from "./CredentialDialog";
import { NetworkError } from "./NetworkError";
import { networkMessage } from "./networkMessage";
import { remoteFieldError, removeRemoteCopy } from "./remoteCopy";
import type { RemoteField, RemoteInput } from "./remoteCopy";
import styles from "./RemotesDialog.module.css";
import type { RemotesTarget } from "./remotesTarget";
import { useNetworkAction } from "./useNetworkAction";
import { useRemoteActions } from "./useRemoteActions";
import { useRemotes } from "./useRemotes";

export interface RemotesDialogProps {
  repoId: RepoId;
  target: RemotesTarget;
  onClose(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

type FormView = { kind: "add" } | { kind: "edit"; name: string };
/** `from` is the form the list was returned to from, whose opener button takes focus again. */
type View = { kind: "list"; from?: FormView } | FormView;

const initialView = (target: RemotesTarget): View =>
  target.mode === "edit" ? { kind: "edit", name: target.name } : { kind: target.mode };

/** Lists, adds, edits and removes the repository's remotes. */
export function RemotesDialog({ repoId, target, onClose, fallbackFocus }: RemotesDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const { remotes, error: loadError, refetch } = useRemotes(repoId);
  const actions = useRemoteActions(repoId);
  const network = useNetworkAction(repoId);
  const [view, setView] = useState<View>(() => initialView(target));
  const [removing, setRemoving] = useState<string | null>(null);
  // A failed submit, with what was sent so the field error names it.
  const [formError, setFormError] = useState<{ error: AppError; input: RemoteInput } | null>(null);
  // A failed remove or fetch after adding, shown above the list.
  const [listError, setListError] = useState<AppError | null>(null);
  // The fetch after adding; network.pending would also count other components' actions.
  const [fetching, setFetching] = useState(false);
  const busy = actions.pending || fetching;

  const editing =
    view.kind === "edit" && remotes !== undefined
      ? remotes.find((r) => r.name === view.name)
      : undefined;
  // Only the add form can show before the remotes have loaded.
  const waiting = remotes === undefined && view.kind !== "add";
  // A failed load replaces "Loading remotes…" with the error and Retry, for any target.
  const loadFailed = waiting && loadError !== null;
  // An edit target for a remote that is not there resolves to the list once, so a later
  // refetch that brings the remote back cannot pop the form open.
  if (view.kind === "edit" && remotes !== undefined && editing === undefined) {
    setView({ kind: "list" });
  }

  useRestoreFocus(fallbackFocus);
  // On open and on each return to the list, focus the button that opened the form, else the box;
  // a form focuses its own Name field.
  useLayoutEffect(() => {
    const box = dialogRef.current as HTMLDivElement;
    if (view.kind === "list") {
      const from = view.from;
      if (from !== undefined) {
        const opener =
          from.kind === "add"
            ? addRef.current
            : Array.from(box.querySelectorAll<HTMLButtonElement>("button[data-edit]")).find(
                (b) => b.dataset.edit === from.name,
              );
        // A renamed remote's Edit button is gone; the box below takes focus instead.
        opener?.focus();
      }
      if (!box.contains(document.activeElement)) box.focus();
    } else if (waiting) {
      box.focus();
    }
  }, [view, waiting]);

  const toList = (from: FormView) => {
    setFormError(null);
    setView({ kind: "list", from });
  };

  const dismissListError = () => setListError(null);

  // Fetches only the remote just added. It stays whatever the fetch does; a failure shows above
  // the list.
  const fetchAfterAdd = async (name: string) => {
    setFetching(true);
    const result = await network.run((credentials) => fetchRemote(repoId, name, credentials));
    setFetching(false);
    if (result.status === "failed") setListError(result.error);
  };

  const submit = async (form: FormView, input: RemoteInput, fetchAfter: boolean) => {
    setFormError(null);
    setListError(null);
    const save =
      form.kind === "add"
        ? actions.add(input.name, input.url, input.pushUrl)
        : actions.update(form.name, input.name, input.url, input.pushUrl);
    const error = await save;
    if (error !== null) setFormError({ error, input });
    else {
      setView({ kind: "list", from: form });
      if (fetchAfter) await fetchAfterAdd(input.name);
    }
  };

  const confirmRemove = async (name: string) => {
    setListError(null);
    const error = await actions.remove(name);
    setRemoving(null);
    setListError(error);
  };

  // A nested dialog is a sibling, but focus can still be clicked back into this box.
  const inert = busy || removing !== null || network.prompt !== null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || inert) return;
    if (view.kind === "list" || loadFailed) onClose();
    else toList(view);
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !inert) onClose();
  };

  const renderList = (list: RemoteInfo[]) => (
    <>
      {listError !== null &&
        (listError.kind === "networkFailed" ? (
          <NetworkError message={networkMessage(listError)} onDismiss={dismissListError} />
        ) : (
          <RepoError error={listError} path={null} variant="panel" onDismiss={dismissListError} />
        ))}
      {list.length === 0 ? (
        <p className={styles.empty}>No remotes</p>
      ) : (
        <ul aria-label="Remotes" className={styles.list}>
          {list.map((r) => (
            <li key={r.name} className={styles.row}>
              <div className={styles.info}>
                <span className={styles.name}>{r.name}</span>
                <span className={styles.url}>{r.fetchUrl}</span>
                {r.pushUrl !== null && r.pushUrl !== r.fetchUrl && (
                  <span className={styles.url}>
                    <span className={styles.urlLabel}>push </span>
                    {r.pushUrl}
                  </span>
                )}
              </div>
              <div className={styles.rowActions}>
                <button
                  data-edit={r.name}
                  type="button"
                  aria-label={`Edit ${r.name}`}
                  disabled={busy}
                  onClick={() => setView({ kind: "edit", name: r.name })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${r.name}`}
                  disabled={busy || network.pending}
                  onClick={() => setRemoving(r.name)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        <button ref={addRef} type="button" disabled={busy} onClick={() => setView({ kind: "add" })}>
          Add remote
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );

  let body: React.ReactNode;
  if (loadFailed) {
    body = (
      <>
        <RepoError
          error={loadError}
          path={null}
          variant="panel"
          onRetry={refetch}
          onDismiss={refetch}
        />
        <div className={styles.actions}>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    );
  } else if (waiting) {
    body = <p role="status">Loading remotes…</p>;
  } else if (view.kind === "list") {
    body = renderList(remotes as RemoteInfo[]);
  } else {
    const form = view;
    body = (
      <RemoteForm
        key={form.kind === "edit" ? `edit:${form.name}` : "add"}
        remote={editing}
        error={formError}
        pending={busy}
        dialogRef={dialogRef}
        onSubmit={(input, fetchAfter) => void submit(form, input, fetchAfter)}
        onCancel={() => toList(form)}
      />
    );
  }

  // The confirm and sign-in dialogs are siblings after the box, so their Escape and backdrop
  // clicks never reach it; the sign-in comes last so it paints above everything.
  return (
    <>
      <div className={styles.backdrop} onClick={onBackdropClick}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={styles.dialog}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <h2 id={titleId} className={styles.title}>
            Remotes
          </h2>
          {body}
        </div>
      </div>
      {removing !== null && (
        <ConfirmDialog
          open
          {...removeRemoteCopy(removing)}
          confirmLabel="Remove"
          danger
          pending={actions.pending}
          onConfirm={() => void confirmRemove(removing)}
          onCancel={() => setRemoving(null)}
          fallbackFocus={dialogRef}
        />
      )}
      <CredentialDialog prompt={network.prompt} fallbackFocus={dialogRef} />
    </>
  );
}

interface RemoteFormProps {
  /** The remote being edited; undefined for an add. */
  remote: RemoteInfo | undefined;
  error: { error: AppError; input: RemoteInput } | null;
  pending: boolean;
  /** Holds focus while pending, when every control is disabled. */
  dialogRef: RefObject<HTMLDivElement | null>;
  onSubmit(input: RemoteInput, fetchAfter: boolean): void;
  onCancel(): void;
}

/** Mounted per open, so its fields initialise from the remote without an effect. */
function RemoteForm({ remote, error, pending, dialogRef, onSubmit, onCancel }: RemoteFormProps) {
  const errorId = useId();
  const nameId = useId();
  const urlId = useId();
  const pushId = useId();
  const [name, setName] = useState(remote?.name ?? "");
  const [url, setUrl] = useState(remote?.fetchUrl ?? "");
  const [pushUrl, setPushUrl] = useState(remote?.pushUrl ?? "");
  const [fetchAfter, setFetchAfter] = useState(true);
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const pushRef = useRef<HTMLInputElement>(null);
  const refs = { name: nameRef, url: urlRef, pushUrl: pushRef };

  const fieldError = error === null ? null : remoteFieldError(error.error, error.input);

  useLayoutEffect(() => {
    (nameRef.current as HTMLInputElement).focus();
  }, []);

  // Disabling the focused control drops focus to the body: hold it on the dialog while pending,
  // then hand it to the field at fault (Name for any other error) when the submit failed.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
    else if (error !== null) {
      const field = remoteFieldError(error.error, error.input)?.field ?? "name";
      (
        ({ name: nameRef, url: urlRef, pushUrl: pushRef })[field].current as HTMLInputElement
      ).focus();
    }
  }, [pending, error, dialogRef]);

  const blank = name.trim() === "" || url.trim() === "";

  // A disabled submit button blocks implicit submission, so a blank or pending form never gets here.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const push = pushUrl.trim();
    onSubmit(
      { name: name.trim(), url: url.trim(), pushUrl: push === "" ? null : push },
      remote === undefined && fetchAfter,
    );
  };

  const describedBy = (field: RemoteField) => (fieldError?.field === field ? errorId : undefined);

  const fieldMessage = (field: RemoteField) =>
    fieldError?.field === field && (
      <p id={errorId} role="alert" className={styles.error}>
        {fieldError.text}
      </p>
    );

  const input = (
    field: RemoteField,
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
  ) => (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <input
        ref={refs[field]}
        id={id}
        type="text"
        value={value}
        disabled={pending}
        aria-describedby={describedBy(field)}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => set(e.target.value)}
      />
      {fieldMessage(field)}
    </div>
  );

  return (
    <form className={styles.form} onSubmit={submit}>
      {error !== null && fieldError === null && (
        <p role="alert" className={styles.error}>
          {error.error.message}
        </p>
      )}
      {input("name", nameId, "Name", name, setName)}
      {input("url", urlId, "URL", url, setUrl)}
      {input("pushUrl", pushId, "Push URL (optional)", pushUrl, setPushUrl)}
      {remote === undefined && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={fetchAfter}
            disabled={pending}
            onChange={(e) => setFetchAfter(e.target.checked)}
          />
          Fetch after adding
        </label>
      )}
      <div className={styles.actions}>
        <button type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={pending || blank}>
          {pending ? "Working…" : remote === undefined ? "Add" : "Save"}
        </button>
      </div>
    </form>
  );
}
