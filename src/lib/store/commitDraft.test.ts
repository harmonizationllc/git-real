import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_DRAFT, useCommitDraft } from "./commitDraft";

const head = { subject: "Head subject", body: "Head body" };

beforeEach(() => {
  useCommitDraft.setState({ drafts: {} });
});

describe("commitDraft store", () => {
  it("has no entry for an unknown repo and EMPTY_DRAFT is the blank draft", () => {
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
    expect(EMPTY_DRAFT).toEqual({ subject: "", body: "", amend: false, stash: null });
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
    });
  });
});
