import { create } from "zustand";
import type { CommitMessage, RepoId } from "../ipc";

/** Text typed before amend was turned on; restored when it is turned off. */
export interface DraftStash {
  subject: string;
  body: string;
}

/**
 * A stash exists exactly while amend is on, so turning amend off always has text to restore.
 * `prefilled` is the operation message last loaded into the draft, null when none was.
 */
export type CommitDraft = { subject: string; body: string; prefilled: CommitMessage | null } & (
  { amend: false; stash: null } | { amend: true; stash: DraftStash }
);

export const EMPTY_DRAFT: CommitDraft = {
  subject: "",
  body: "",
  amend: false,
  stash: null,
  prefilled: null,
};

interface CommitDraftState {
  drafts: Record<RepoId, CommitDraft>;
  setSubject(repoId: RepoId, subject: string): void;
  setBody(repoId: RepoId, body: string): void;
  /** Turning amend on stashes the draft and loads `head`; turning it off restores the stash. */
  setAmend(repoId: RepoId, on: boolean, head: CommitMessage | null): void;
  /**
   * Keeps the draft in step with an operation's prepared message (null = no committing
   * operation). Text the user typed is never overwritten.
   */
  syncPrefill(repoId: RepoId, message: CommitMessage | null): void;
  clear(repoId: RepoId): void;
}

function toggleAmend(draft: CommitDraft, on: boolean, head: CommitMessage | null): CommitDraft {
  const { prefilled } = draft;
  if (draft.amend) {
    return on ? draft : { ...draft.stash, amend: false, stash: null, prefilled };
  }
  if (!on) return draft;
  const stash = { subject: draft.subject, body: draft.body };
  const text = head === null ? stash : { subject: head.subject, body: head.body };
  return { ...text, amend: true, stash, prefilled };
}

const sameText = (draft: CommitDraft, message: CommitMessage) =>
  draft.subject === message.subject && draft.body === message.body;

function withoutDraft(drafts: Record<RepoId, CommitDraft>, repoId: RepoId) {
  const next = { ...drafts };
  delete next[repoId];
  return next;
}

/** Per-repository commit drafts; in memory only, since repo ids are per launch. */
export const useCommitDraft = create<CommitDraftState>()((set) => {
  const update = (repoId: RepoId, fn: (draft: CommitDraft) => CommitDraft) =>
    set((state) => ({
      drafts: { ...state.drafts, [repoId]: fn(state.drafts[repoId] ?? EMPTY_DRAFT) },
    }));
  return {
    drafts: {},
    setSubject: (repoId, subject) => update(repoId, (d) => ({ ...d, subject })),
    setBody: (repoId, body) => update(repoId, (d) => ({ ...d, body })),
    setAmend: (repoId, on, head) => update(repoId, (d) => toggleAmend(d, on, head)),
    // Reads and writes the current draft in one `set`, so it cannot race with typing.
    syncPrefill: (repoId, message) =>
      set((state) => {
        const current = state.drafts[repoId];
        if (message === null) {
          if (current === undefined || current.prefilled === null) return state;
          if (sameText(current, current.prefilled)) {
            return { drafts: withoutDraft(state.drafts, repoId) };
          }
          return { drafts: { ...state.drafts, [repoId]: { ...current, prefilled: null } } };
        }
        // Judge the user's own text: an amend draft shows HEAD's message, not theirs.
        const base = toggleAmend(current ?? EMPTY_DRAFT, false, null);
        const untouched =
          (base.subject === "" && base.body === "") ||
          (base.prefilled !== null && sameText(base, base.prefilled));
        const next: CommitDraft = untouched
          ? {
              subject: message.subject,
              body: message.body,
              amend: false,
              stash: null,
              prefilled: message,
            }
          : base;
        return { drafts: { ...state.drafts, [repoId]: next } };
      }),
    clear: (repoId) =>
      set((state) =>
        repoId in state.drafts ? { drafts: withoutDraft(state.drafts, repoId) } : state,
      ),
  };
});
