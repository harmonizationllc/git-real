import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "./workspace";

beforeEach(() => {
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

describe("initial state", () => {
  it("should start with no selection for any repo", () => {
    expect(useWorkspace.getState().selected).toEqual({});
  });

  it("should start with no selected commit for any repo", () => {
    expect(useWorkspace.getState().selectedCommit).toEqual({});
  });
});

// Contract: the selected file is tracked per repo id.
describe("select", () => {
  it("should store the selected file for the repo", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "staged" });
  });

  it("should keep selections of different repos independent", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(2, { path: "b.txt", scope: "unstaged" });
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "staged" });
    expect(useWorkspace.getState().selected[2]).toEqual({ path: "b.txt", scope: "unstaged" });
  });

  it("should replace the previous selection of the same repo", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(1, { path: "b.txt", scope: "unstaged" });
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "b.txt", scope: "unstaged" });
  });

  it("should store null when called with null", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(1, null);
    expect(useWorkspace.getState().selected[1]).toBeNull();
  });

  it("should replace the selected record instead of mutating it", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    const before = useWorkspace.getState().selected;
    useWorkspace.getState().select(2, null);
    expect(useWorkspace.getState().selected).not.toBe(before);
  });
});

describe("clear", () => {
  it("should remove the selection of that repo", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selected[1] ?? null).toBeNull();
  });

  it("should leave other repos untouched", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(2, { path: "b.txt", scope: "staged" });
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selected[2]).toEqual({ path: "b.txt", scope: "staged" });
  });

  it("should leave state unchanged for a repo with no selection", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    const before = useWorkspace.getState().selected;
    useWorkspace.getState().clear(99);
    expect(useWorkspace.getState().selected).toBe(before);
  });
});

// Contract: the selected commit is tracked per repo id, independently of the selected file.
describe("selectCommit", () => {
  it("should store the selected commit for the repo", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    expect(useWorkspace.getState().selectedCommit[1]).toBe("abc");
  });

  it("should keep selections of different repos independent", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().selectCommit(2, "def");
    expect(useWorkspace.getState().selectedCommit).toEqual({ 1: "abc", 2: "def" });
  });

  it("should replace the previous commit of the same repo", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().selectCommit(1, "def");
    expect(useWorkspace.getState().selectedCommit[1]).toBe("def");
  });

  it("should store null when called with null", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().selectCommit(1, null);
    expect(useWorkspace.getState().selectedCommit[1]).toBeNull();
  });

  it("should not touch the selected file", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().selectCommit(1, "abc");
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "staged" });
  });

  it("should not touch the selected commit when a file is selected", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    expect(useWorkspace.getState().selectedCommit[1]).toBe("abc");
  });

  it("should replace the selectedCommit record instead of mutating it", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    const before = useWorkspace.getState().selectedCommit;
    useWorkspace.getState().selectCommit(2, null);
    expect(useWorkspace.getState().selectedCommit).not.toBe(before);
  });
});

describe("clear with a selected commit", () => {
  it("should remove both the file and the commit selection of that repo", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().clear(1);
    expect([
      useWorkspace.getState().selected[1] ?? null,
      useWorkspace.getState().selectedCommit[1] ?? null,
    ]).toEqual([null, null]);
  });

  it("should leave the commit selection of other repos untouched", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().selectCommit(2, "def");
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selectedCommit[2]).toBe("def");
  });

  it("should leave selectedCommit unchanged for a repo with no commit selection", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().clear(99);
    expect(useWorkspace.getState().selectedCommit[1]).toBe("abc");
  });
});

// Coverage: untouched records keep their identity so subscribers do not re-render.
describe("record reference stability", () => {
  it("should keep the selectedCommit record when a file is selected", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    const before = useWorkspace.getState().selectedCommit;
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    expect(useWorkspace.getState().selectedCommit).toBe(before);
  });

  it("should keep the selected record when a commit is selected", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    const before = useWorkspace.getState().selected;
    useWorkspace.getState().selectCommit(1, "abc");
    expect(useWorkspace.getState().selected).toBe(before);
  });

  it("should keep the whole state when clearing a repo with no selections", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().selectCommit(1, "abc");
    const before = useWorkspace.getState();
    useWorkspace.getState().clear(99);
    expect(useWorkspace.getState()).toBe(before);
  });

  it("should keep the selectedCommit record when clearing a repo that only has a file", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().selectCommit(2, "abc");
    const before = useWorkspace.getState().selectedCommit;
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selectedCommit).toBe(before);
  });

  it("should keep the selected record when clearing a repo that only has a commit", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().select(2, { path: "a.txt", scope: "staged" });
    const before = useWorkspace.getState().selected;
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selected).toBe(before);
  });

  it("should replace both records when clearing a repo with both selections", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().selectCommit(1, "abc");
    const { selected, selectedCommit } = useWorkspace.getState();
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selected).not.toBe(selected);
    expect(useWorkspace.getState().selectedCommit).not.toBe(selectedCommit);
  });

  it("should not mutate the previous selectedCommit record when clearing", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    const before = useWorkspace.getState().selectedCommit;
    useWorkspace.getState().clear(1);
    expect(before).toEqual({ 1: "abc" });
  });

  it("should remove the key rather than store null when clearing", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().selectedCommit).toBe(false);
  });

  it("should keep a commit selection that was set to null as an own key", () => {
    useWorkspace.getState().selectCommit(1, null);
    expect(useWorkspace.getState().selectedCommit).toEqual({ 1: null });
  });
});

describe("clear with only a commit selection", () => {
  it("should remove the commit selection and keep the untouched file map reference", () => {
    useWorkspace.getState().selectCommit(1, "abc");
    useWorkspace.getState().select(2, { path: "a.txt", scope: "staged" });
    const files = useWorkspace.getState().selected;
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().selectedCommit).toBe(false);
    expect(useWorkspace.getState().selected).toBe(files);
  });
});

// Contract: GR-9 history path and centre view are tracked per repo; select leaves the view alone.
describe("history path", () => {
  it("should start with no history path for any repo", () => {
    expect(useWorkspace.getState().historyPath).toEqual({});
  });

  it("should store the path passed to showHistory", () => {
    useWorkspace.getState().showHistory(1, "a.ts");
    expect(useWorkspace.getState().historyPath[1]).toBe("a.ts");
  });

  it("should store null when showHistory is called with null", () => {
    useWorkspace.getState().showHistory(1, "a.ts");
    useWorkspace.getState().showHistory(1, null);
    expect(useWorkspace.getState().historyPath[1]).toBeNull();
  });

  it("should keep history paths of different repos independent", () => {
    useWorkspace.getState().showHistory(1, "a.ts");
    useWorkspace.getState().showHistory(2, "b.ts");
    expect(useWorkspace.getState().historyPath).toEqual({ 1: "a.ts", 2: "b.ts" });
  });
});

describe("centre view", () => {
  it("should start with no centre view for any repo", () => {
    expect(useWorkspace.getState().centreView).toEqual({});
  });

  it("should store the view passed to setCentreView", () => {
    useWorkspace.getState().setCentreView(1, "blame");
    expect(useWorkspace.getState().centreView[1]).toBe("blame");
  });

  it("should switch back to diff", () => {
    useWorkspace.getState().setCentreView(1, "blame");
    useWorkspace.getState().setCentreView(1, "diff");
    expect(useWorkspace.getState().centreView[1]).toBe("diff");
  });

  it("should keep the centre view when another file is selected", () => {
    useWorkspace.getState().setCentreView(1, "blame");
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(1, { path: "b.txt", scope: { commit: "abc" } });
    expect(useWorkspace.getState().centreView[1]).toBe("blame");
  });

  it("should accept a commit scope as the selection", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: { commit: "abc" } });
    expect(useWorkspace.getState().selected[1]).toEqual({
      path: "a.txt",
      scope: { commit: "abc" },
    });
  });
});

describe("clear with history state", () => {
  it("should forget the history path of the repo", () => {
    useWorkspace.getState().showHistory(1, "a.ts");
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().historyPath).toBe(false);
  });

  it("should forget the centre view of the repo", () => {
    useWorkspace.getState().setCentreView(1, "blame");
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().centreView).toBe(false);
  });

  it("should leave other repos history path and centre view alone", () => {
    useWorkspace.getState().showHistory(2, "b.ts");
    useWorkspace.getState().setCentreView(2, "blame");
    useWorkspace.getState().showHistory(1, "a.ts");
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().historyPath[2]).toBe("b.ts");
    expect(useWorkspace.getState().centreView[2]).toBe("blame");
  });

  it("should clear a repo that only has a history path", () => {
    useWorkspace.getState().showHistory(1, "a.ts");
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().historyPath).toEqual({});
  });

  it("should clear a repo that only has a centre view", () => {
    useWorkspace.getState().setCentreView(1, "blame");
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().centreView).toEqual({});
  });
});

describe("reference stability with history state", () => {
  it("should return the same state object when clearing an absent repo", () => {
    useWorkspace.getState().showHistory(2, "b.ts");
    useWorkspace.getState().setCentreView(2, "blame");
    const before = useWorkspace.getState();
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState()).toBe(before);
  });

  it("should keep the centreView record when a file is selected", () => {
    useWorkspace.getState().setCentreView(1, "blame");
    const before = useWorkspace.getState().centreView;
    useWorkspace.getState().select(1, { path: "a", scope: "staged" });
    expect(useWorkspace.getState().centreView).toBe(before);
  });

  it("should keep the centreView record when the selection is cleared with null", () => {
    useWorkspace.getState().setCentreView(1, "blame");
    const before = useWorkspace.getState().centreView;
    useWorkspace.getState().select(1, null);
    expect(useWorkspace.getState().centreView).toBe(before);
  });
});

// Contract: clear forgets all four records of one repo and nothing of any other.
describe("clear with every record set", () => {
  const fill = (id: number) => {
    const w = useWorkspace.getState();
    w.select(id, { path: `f${id}`, scope: { commit: "abc" } });
    w.selectCommit(id, `c${id}`);
    w.showHistory(id, `h${id}`);
    w.setCentreView(id, "blame");
  };
  it("should remove all four records of the repo", () => {
    fill(1);
    useWorkspace.getState().clear(1);
    const s = useWorkspace.getState();
    expect([1 in s.selected, 1 in s.selectedCommit, 1 in s.historyPath, 1 in s.centreView]).toEqual(
      [false, false, false, false],
    );
  });
  it("should keep all four records of another repo", () => {
    fill(1);
    fill(2);
    useWorkspace.getState().clear(1);
    const s = useWorkspace.getState();
    expect(s.selected[2]).toEqual({ path: "f2", scope: { commit: "abc" } });
    expect(s.selectedCommit[2]).toBe("c2");
    expect(s.historyPath[2]).toBe("h2");
    expect(s.centreView[2]).toBe("blame");
  });
  it("should clear a repo whose only record is a null selection", () => {
    useWorkspace.getState().select(1, null);
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().selected).toBe(false);
  });
  it("should clear a repo whose history path is null", () => {
    useWorkspace.getState().showHistory(1, null);
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().historyPath).toBe(false);
  });
  it("should keep the untouched records by reference when only history is cleared", () => {
    useWorkspace.getState().showHistory(1, "h");
    useWorkspace.getState().select(2, { path: "x", scope: "staged" });
    const { selected, selectedCommit, centreView } = useWorkspace.getState();
    useWorkspace.getState().clear(1);
    const s = useWorkspace.getState();
    expect(s.selected).toBe(selected);
    expect(s.selectedCommit).toBe(selectedCommit);
    expect(s.centreView).toBe(centreView);
  });
});

// Contract (GR-11a): a selected stash and a selected commit are mutually exclusive per repo.
describe("selectStash", () => {
  it("should store the selected stash for the repo", () => {
    useWorkspace.getState().selectStash(1, "w1");
    expect(useWorkspace.getState().selectedStash[1]).toBe("w1");
  });

  it("should start with no selected stash for any repo", () => {
    expect(useWorkspace.getState().selectedStash).toEqual({});
  });

  it("selectStash with an oid clears the selected commit", () => {
    useWorkspace.getState().selectCommit(1, "c1");
    useWorkspace.getState().selectStash(1, "w1");
    expect(useWorkspace.getState().selectedCommit[1]).toBeNull();
  });

  it("selectStash with null leaves the selected commit alone", () => {
    useWorkspace.getState().selectCommit(1, "c1");
    useWorkspace.getState().selectStash(1, null);
    expect(useWorkspace.getState().selectedCommit[1]).toBe("c1");
  });

  it("selectStash with null stores null for the stash", () => {
    useWorkspace.getState().selectStash(1, "w1");
    useWorkspace.getState().selectStash(1, null);
    expect(useWorkspace.getState().selectedStash[1]).toBeNull();
  });

  it("selectCommit with an oid clears the selected stash", () => {
    useWorkspace.getState().selectStash(1, "w1");
    useWorkspace.getState().selectCommit(1, "c1");
    expect(useWorkspace.getState().selectedStash[1]).toBeNull();
  });

  it("selectCommit with null leaves the selected stash alone", () => {
    useWorkspace.getState().selectStash(1, "w1");
    useWorkspace.getState().selectCommit(1, null);
    expect(useWorkspace.getState().selectedStash[1]).toBe("w1");
  });

  it("should keep other repos untouched", () => {
    useWorkspace.getState().selectStash(1, "w1");
    useWorkspace.getState().selectCommit(2, "c");
    expect(useWorkspace.getState().selectedStash[1]).toBe("w1");
  });

  it("should keep the stash selection of another repo when a stash is selected", () => {
    useWorkspace.getState().selectCommit(2, "c2");
    useWorkspace.getState().selectStash(1, "w1");
    expect(useWorkspace.getState().selectedCommit[2]).toBe("c2");
  });

  it("should not touch the selected file", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().selectStash(1, "w1");
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "staged" });
  });
});

describe("clear with a selected stash", () => {
  it("should forget the selected stash", () => {
    useWorkspace.getState().selectStash(1, "w");
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().selectedStash).toBe(false);
  });

  it("should clear a repo whose only stored value is a selected stash", () => {
    useWorkspace.getState().selectStash(1, "w");
    const before = useWorkspace.getState();
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState()).not.toBe(before);
  });

  it("should leave the stash selection of other repos untouched", () => {
    useWorkspace.getState().selectStash(1, "w1");
    useWorkspace.getState().selectStash(2, "w2");
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selectedStash[2]).toBe("w2");
  });
});

// Contract: the branch and tag filter text is stored per repo and forgotten with the repo.
describe("refsFilter", () => {
  it("should start with no filter text for any repo", () => {
    expect(useWorkspace.getState().refsFilter).toEqual({});
  });

  it("should store the filter text per repo", () => {
    useWorkspace.getState().setRefsFilter(1, "rel");
    useWorkspace.getState().setRefsFilter(2, "fix");
    expect(useWorkspace.getState().refsFilter).toEqual({ 1: "rel", 2: "fix" });
  });

  it("should keep the text as typed, spaces included", () => {
    useWorkspace.getState().setRefsFilter(1, "  v1 ");
    expect(useWorkspace.getState().refsFilter[1]).toBe("  v1 ");
  });

  it("should replace the previous text of the same repo", () => {
    useWorkspace.getState().setRefsFilter(1, "a");
    useWorkspace.getState().setRefsFilter(1, "");
    expect(useWorkspace.getState().refsFilter[1]).toBe("");
  });

  it("should replace the record instead of mutating it", () => {
    useWorkspace.getState().setRefsFilter(1, "a");
    const before = useWorkspace.getState().refsFilter;
    useWorkspace.getState().setRefsFilter(1, "b");
    expect(useWorkspace.getState().refsFilter).not.toBe(before);
    expect(before).toEqual({ 1: "a" });
  });
});

describe("clear with a refs filter", () => {
  it("should forget the refs filter of that repo", () => {
    useWorkspace.getState().setRefsFilter(1, "x");
    useWorkspace.getState().clear(1);
    expect(1 in useWorkspace.getState().refsFilter).toBe(false);
  });

  it("should keep the refs filter of another repo", () => {
    useWorkspace.getState().setRefsFilter(1, "x");
    useWorkspace.getState().setRefsFilter(2, "y");
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().refsFilter).toEqual({ 2: "y" });
  });

  it("should clear a repo whose only stored value is a refs filter", () => {
    useWorkspace.getState().setRefsFilter(1, "x");
    const before = useWorkspace.getState();
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState()).not.toBe(before);
  });

  it("should keep the whole state when clearing a repo with no refs filter", () => {
    useWorkspace.getState().setRefsFilter(2, "y");
    const before = useWorkspace.getState();
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState()).toBe(before);
  });

  it("should keep the refsFilter record by reference when only a selection is cleared", () => {
    useWorkspace.getState().setRefsFilter(2, "y");
    useWorkspace.getState().select(1, { path: "a", scope: "staged" });
    const { refsFilter } = useWorkspace.getState();
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().refsFilter).toBe(refsFilter);
  });
});
