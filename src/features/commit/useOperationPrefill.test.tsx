import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationState } from "../../lib/ipc";
import { EMPTY_DRAFT, useCommitDraft } from "../../lib/store/commitDraft";
import { useOperationState } from "../merge/useOperationState";
import { useOperationPrefill } from "./useOperationPrefill";

vi.mock("../merge/useOperationState", () => ({ useOperationState: vi.fn() }));

const REPO = 1;
const message = { subject: "Merge branch 'feature'", body: "Conflicts:\n\ta.txt" };
const merge: OperationState = { kind: "merge", head: "a".repeat(40), branch: "feature", message };
const pick: OperationState = {
  kind: "cherryPick",
  oid: "c".repeat(40),
  message: { subject: "Pick it", body: "" },
};
const revert: OperationState = {
  kind: "revert",
  oid: "d".repeat(40),
  message: { subject: 'Revert "Pick it"', body: "This reverts commit ddddddd." },
};
const rebase: OperationState = {
  kind: "rebase",
  onto: "b".repeat(40),
  ontoName: "main",
  branch: "feature",
  step: 1,
  total: 2,
};
const none: OperationState = { kind: "none" };

const draft = () => useCommitDraft.getState().drafts[REPO];

function provide(state: OperationState | undefined) {
  vi.mocked(useOperationState).mockReturnValue({ state, error: null, refetch: vi.fn() });
}

function mount(state: OperationState | undefined, repoId = REPO) {
  provide(state);
  return renderHook(({ id }) => useOperationPrefill(id), { initialProps: { id: repoId } });
}

beforeEach(() => {
  vi.resetAllMocks();
  useCommitDraft.setState({ drafts: {} });
});

// Contract: the first observation of a committing operation loads git's prepared message.
describe("useOperationPrefill prefill", () => {
  it("should prefill on first observation of a merge", () => {
    mount(merge);
    expect(draft()).toMatchObject({ subject: message.subject, body: message.body });
  });

  it("should record the prefilled message on the draft", () => {
    mount(merge);
    expect(draft()?.prefilled).toEqual(message);
  });

  it("should prefill for a cherry-pick", () => {
    mount(pick);
    expect(draft()).toMatchObject({ subject: "Pick it", prefilled: pick.message });
  });

  it("should prefill for a revert", () => {
    mount(revert);
    expect(draft()).toMatchObject({ subject: 'Revert "Pick it"' });
  });

  it("should prefill when the operation appears after the first render", () => {
    const view = mount(none);
    provide(merge);
    view.rerender({ id: REPO });
    expect(draft()?.subject).toBe(message.subject);
  });

  it("should leave user text alone when the draft has text on first observation", () => {
    useCommitDraft.getState().setSubject(REPO, "mine");
    mount(merge);
    expect(draft()?.subject).toBe("mine");
  });

  it("should prefill the repository it is mounted for", () => {
    mount(merge, 5);
    expect(useCommitDraft.getState().drafts[5]?.subject).toBe(message.subject);
    expect(useCommitDraft.getState().drafts[REPO]).toBeUndefined();
  });
});

// Contract: refetching the same state never clobbers what the user typed.
describe("useOperationPrefill refetch", () => {
  it("should not overwrite edited text on refetch", () => {
    const view = mount(merge);
    useCommitDraft.getState().setSubject(REPO, "My own subject");
    view.rerender({ id: REPO });
    expect(draft()?.subject).toBe("My own subject");
  });

  it("should not overwrite edited text when a structurally equal state arrives", () => {
    const view = mount(merge);
    useCommitDraft.getState().setBody(REPO, "my body");
    provide({ ...merge, message: { ...message } });
    view.rerender({ id: REPO });
    expect(draft()?.body).toBe("my body");
  });

  it("should not touch the draft while the state is still loading", () => {
    useCommitDraft.getState().setSubject(REPO, "typed");
    mount(undefined);
    expect(draft()?.subject).toBe("typed");
  });

  it("should not create a draft while the state is still loading", () => {
    mount(undefined);
    expect(draft()).toBeUndefined();
  });
});

// Contract: leaving an operation clears the prefill only while the user left it untouched.
describe("useOperationPrefill transition out", () => {
  it("should clear an untouched prefill on a transition to none", () => {
    const view = mount(merge);
    provide(none);
    view.rerender({ id: REPO });
    expect(useCommitDraft.getState().drafts[REPO]).toBeUndefined();
  });

  it("should keep edited text on a transition to none", () => {
    const view = mount(merge);
    useCommitDraft.getState().setSubject(REPO, "edited");
    provide(none);
    view.rerender({ id: REPO });
    expect(draft()?.subject).toBe("edited");
  });

  it("should forget the prefilled marker when edited text is kept", () => {
    const view = mount(merge);
    useCommitDraft.getState().setSubject(REPO, "edited");
    provide(none);
    view.rerender({ id: REPO });
    expect(draft()?.prefilled).toBeNull();
  });

  it("should leave a draft alone when there was never an operation", () => {
    useCommitDraft.getState().setSubject(REPO, "typed");
    mount(none);
    expect(draft()).toEqual({ ...EMPTY_DRAFT, subject: "typed" });
  });
});

// Contract: a rebase continues from the banner, so it never prefills.
describe("useOperationPrefill rebase", () => {
  it("should not prefill for a rebase", () => {
    mount(rebase);
    expect(draft()).toBeUndefined();
  });

  it("should clear an untouched prefill when a rebase replaces the operation", () => {
    const view = mount(merge);
    provide(rebase);
    view.rerender({ id: REPO });
    expect(useCommitDraft.getState().drafts[REPO]).toBeUndefined();
  });
});

// Contract: the hook returns the state for the box to render.
describe("useOperationPrefill result", () => {
  it("should return the operation state", () => {
    const view = mount(merge);
    expect(view.result.current).toBe(merge);
  });

  it("should return undefined while the state is loading", () => {
    const view = mount(undefined);
    expect(view.result.current).toBeUndefined();
  });

  it("should return none unchanged", () => {
    const view = mount(none);
    expect(view.result.current).toBe(none);
  });

  it("should read the state for its own repository", () => {
    mount(merge, 9);
    expect(useOperationState).toHaveBeenCalledWith(9);
  });
});
