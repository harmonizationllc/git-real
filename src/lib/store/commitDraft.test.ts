import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_DRAFT, useCommitDraft } from "./commitDraft";

const head = { subject: "Head subject", body: "Head body" };

beforeEach(() => {
  useCommitDraft.setState({ drafts: {} });
});

describe("commitDraft store", () => {
  it("has no entry for an unknown repo and EMPTY_DRAFT is the blank draft", () => {
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
    expect(EMPTY_DRAFT).toEqual({
      subject: "",
      body: "",
      amend: false,
      stash: null,
      prefilled: null,
    });
  });

  it("setSubject and setBody update one repo only", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "One");
    s.setBody(1, "Body one");
    s.setSubject(2, "Two");
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ subject: "One", body: "Body one" });
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "Two", body: "" });
  });

  it("setAmend on stashes the typed text and prefills from head", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setBody(1, "typed body");
    s.setAmend(1, true, head);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "Head subject",
      body: "Head body",
      amend: true,
      stash: { subject: "typed", body: "typed body" },
      prefilled: null,
    });
  });

  it("setAmend off restores the stash and clears it", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, true, head);
    s.setSubject(1, "edited head");
    s.setAmend(1, false, head);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "typed",
      body: "",
      amend: false,
      stash: null,
      prefilled: null,
    });
  });

  it("setAmend on twice does not overwrite the stash", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, true, head);
    s.setSubject(1, "edited");
    s.setAmend(1, true, head);
    expect(useCommitDraft.getState().drafts[1].stash).toEqual({ subject: "typed", body: "" });
    expect(useCommitDraft.getState().drafts[1].subject).toBe("edited");
  });

  it("setAmend with null head keeps the typed text", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, true, null);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ subject: "typed", amend: true });
  });

  it("setAmend off with no stash keeps the current text", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, false, head);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "typed",
      amend: false,
      stash: null,
      prefilled: null,
    });
  });

  it("clear removes the repo's draft and leaves others", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "a");
    s.setSubject(2, "b");
    s.clear(1);
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "b" });
  });

  it("clear on an unknown repo is a no-op that keeps state identity", () => {
    const before = useCommitDraft.getState();
    before.clear(9);
    expect(useCommitDraft.getState().drafts).toBe(before.drafts);
  });

  it("setAmend off after on restores both subject and body from the stash", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "t");
    s.setBody(1, "tb");
    s.setAmend(1, true, head);
    s.setAmend(1, false, head);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "t",
      body: "tb",
      amend: false,
      stash: null,
      prefilled: null,
    });
  });

  it("setAmend does not touch other repos", () => {
    const s = useCommitDraft.getState();
    s.setSubject(2, "other");
    s.setAmend(1, true, head);
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "other", amend: false });
  });

  it("setAmend on while already on ignores a changed head and keeps text and stash", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setAmend(1, true, head);
    s.setBody(1, "edited body");
    s.setAmend(1, true, { subject: "Other head", body: "Other body" });
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "Head subject",
      body: "edited body",
      amend: true,
      stash: { subject: "typed", body: "" },
      prefilled: null,
    });
  });
});

const mergeMsg = { subject: "Merge branch 'feature'", body: "" };
const otherMsg = { subject: "Cherry-pick", body: "picked body" };

// Contract: syncPrefill keeps the draft in step with an operation's prepared message
// without ever overwriting text the user typed.
describe("commitDraft syncPrefill with a message", () => {
  it("should expose prefilled null on the blank draft", () => {
    expect(EMPTY_DRAFT.prefilled).toBeNull();
  });

  it("should fill an absent draft and record the prefill", () => {
    useCommitDraft.getState().syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: mergeMsg.subject,
      body: "",
      amend: false,
      stash: null,
      prefilled: mergeMsg,
    });
  });

  it("should fill subject and body when both are empty", () => {
    useCommitDraft.getState().syncPrefill(1, otherMsg);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "Cherry-pick",
      body: "picked body",
    });
  });

  it("should leave a draft with typed subject untouched", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "my own");
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "my own",
      body: "",
      prefilled: null,
    });
  });

  it("should leave a draft with only a typed body untouched", () => {
    const s = useCommitDraft.getState();
    s.setBody(1, "only body");
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "",
      body: "only body",
      prefilled: null,
    });
  });

  it("should leave an edited prefill untouched when the message arrives again", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setSubject(1, "edited");
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "edited",
      prefilled: mergeMsg,
    });
  });

  it("should refill when the text still equals the previous prefill", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.syncPrefill(1, otherMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "Cherry-pick",
      body: "picked body",
      amend: false,
      stash: null,
      prefilled: otherMsg,
    });
  });

  it("should not touch other repos", () => {
    const s = useCommitDraft.getState();
    s.setSubject(2, "other");
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({
      subject: "other",
      prefilled: null,
    });
  });

  it("should keep prefilled when amend is turned on", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setAmend(1, true, head);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ amend: true, prefilled: mergeMsg });
  });

  it("should keep prefilled when amend is turned back off", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setAmend(1, true, head);
    s.setAmend(1, false, head);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: mergeMsg.subject,
      amend: false,
      prefilled: mergeMsg,
    });
  });
});

describe("commitDraft syncPrefill with null", () => {
  it("should clear the draft when the text is still the untouched prefill", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.syncPrefill(1, null);
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
  });

  it("should keep edited text and drop the prefill marker", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setSubject(1, "edited");
    s.syncPrefill(1, null);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "edited",
      prefilled: null,
    });
  });

  it("should keep an edited body and drop the prefill marker", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setBody(1, "extra");
    s.syncPrefill(1, null);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: mergeMsg.subject,
      body: "extra",
      prefilled: null,
    });
  });

  it("should keep text the user typed without any prefill", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.syncPrefill(1, null);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "typed",
      prefilled: null,
    });
  });

  it("should leave other repos' drafts alone when clearing", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setSubject(2, "keep");
    s.syncPrefill(1, null);
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "keep" });
  });

  it("should not create a draft for a repo that never had one", () => {
    useCommitDraft.getState().syncPrefill(7, null);
    expect(useCommitDraft.getState().drafts[7]).toBeUndefined();
  });

  it("should leave the state object untouched when there is nothing to drop", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    const before = useCommitDraft.getState();
    before.syncPrefill(1, null);
    expect(useCommitDraft.getState()).toBe(before);
  });
});

describe("commitDraft syncPrefill over an amend draft", () => {
  it("should drop amend and the stash, then fill, when the restored text is empty", () => {
    const s = useCommitDraft.getState();
    s.setAmend(1, true, head);
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: mergeMsg.subject,
      body: "",
      amend: false,
      stash: null,
      prefilled: mergeMsg,
    });
  });
});

// Coverage audit: rules the first round left implicit.
describe("commitDraft syncPrefill edge rules", () => {
  it("should refill a draft the user emptied after the prefill was loaded", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setSubject(1, "");
    s.syncPrefill(1, otherMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "Cherry-pick",
      body: "picked body",
      amend: false,
      stash: null,
      prefilled: otherMsg,
    });
  });

  it("should give the same draft when the same message arrives twice", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    const first = useCommitDraft.getState().drafts[1];
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual(first);
  });

  it("should not refill typed text after the prefill marker was dropped", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setSubject(1, "edited");
    s.syncPrefill(1, null);
    s.syncPrefill(1, otherMsg);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "edited",
      prefilled: null,
    });
  });

  it("should fill again after the untouched prefill was cleaned up", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.syncPrefill(1, null);
    s.syncPrefill(1, otherMsg);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: "Cherry-pick",
      prefilled: otherMsg,
    });
  });

  it("should record the new message object as prefilled when equal text arrives in a new object", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    const copy = { ...mergeMsg };
    s.syncPrefill(1, copy);
    expect(useCommitDraft.getState().drafts[1]?.prefilled).toBe(copy);
  });

  it("should drop the prefilled draft with clear and fill again afterwards", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.clear(1);
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
    s.syncPrefill(1, otherMsg);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ prefilled: otherMsg });
  });

  it("should judge the stashed text of an amend draft, not the HEAD message it shows", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed before amend");
    s.setAmend(1, true, head);
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "typed before amend",
      body: "",
      amend: false,
      stash: null,
      prefilled: null,
    });
  });

  it("should refill an amend draft whose stash still holds the previous prefill", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setAmend(1, true, head);
    s.syncPrefill(1, otherMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "Cherry-pick",
      body: "picked body",
      amend: false,
      stash: null,
      prefilled: otherMsg,
    });
  });

  it("should drop the prefill marker but keep amend on when null arrives over an amend draft", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setAmend(1, true, head);
    s.syncPrefill(1, null);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: head.subject,
      body: head.body,
      amend: true,
      prefilled: null,
    });
  });

  it("should keep the stash when null arrives over an amend draft", () => {
    const s = useCommitDraft.getState();
    s.syncPrefill(1, mergeMsg);
    s.setAmend(1, true, head);
    s.syncPrefill(1, null);
    s.setAmend(1, false, head);
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({
      subject: mergeMsg.subject,
      amend: false,
      stash: null,
    });
  });

  it("should restore typed stash text, drop amend and leave prefilled unchanged", () => {
    const s = useCommitDraft.getState();
    s.setSubject(1, "typed");
    s.setBody(1, "typed body");
    s.setAmend(1, true, head);
    s.syncPrefill(1, mergeMsg);
    expect(useCommitDraft.getState().drafts[1]).toEqual({
      subject: "typed",
      body: "typed body",
      amend: false,
      stash: null,
      prefilled: null,
    });
  });
});
