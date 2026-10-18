import { create } from "zustand";
import type { CommitMessage, RepoId } from "../ipc";

/** Text typed before amend was turned on; restored when it is turned off. */
export interface DraftStash {
  subject: string;
  body: string;
}

/** A stash exists exactly while amend is on, so turning amend off always has text to restore. */
export type CommitDraft = { subject: string; body: string } & (
  { amend: false; stash: null } | { amend: true; stash: DraftStash }
);

export const EMPTY_DRAFT: CommitDraft = { subject: "", body: "", amend: false, stash: null };

interface CommitDraftState {
  drafts: Record<RepoId, CommitDraft>;
  setSubject(repoId: RepoId, subject: string): void;
  setBody(repoId: RepoId, body: string): void;
  /** Turning amend on stashes the draft and loads `head`; turning it off restores the stash. */
  setAmend(repoId: RepoId, on: boolean, head: CommitMessage | null): void;
  clear(repoId: RepoId): void;
}

function toggleAmend(draft: CommitDraft, on: boolean, head: CommitMessage | null): CommitDraft {
  if (draft.amend) {
    return on ? draft : { ...draft.stash, amend: false, stash: null };
  }
  if (!on) return draft;
  const stash = { subject: draft.subject, body: draft.body };
  const text = head === null ? stash : { subject: head.subject, body: head.body };
  return { ...text, amend: true, stash };
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
    clear: (repoId) =>
      set((state) => {
        if (!(repoId in state.drafts)) return state;
        const drafts = { ...state.drafts };
        delete drafts[repoId];
        return { drafts };
      }),
  };
});
