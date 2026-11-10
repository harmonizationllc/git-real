import { act, fireEvent, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutBranch,
  hostingListIssues,
  hostingListPullRequests,
  hostingRepoContext,
  listBranches,
  listLinkedWorktrees,
  listRemotes,
  listStashes,
  listTags,
  pullDefaultMode,
  updateSettings,
} from "../lib/ipc";
import type { BranchList } from "../lib/ipc";
import { useSettings } from "../lib/store/settings";
import { useWorkspace } from "../lib/store/workspace";
import { declarationsOf } from "../test/cssRules";
import { resetSettings, seedSettings } from "../test/settingsStore";
import { remoteInfo } from "../test/remoteFixtures";
import { renderWithProviders } from "../test/renderWithProviders";
import { linkedWorktree } from "../test/worktreeFixtures";
import { RefsColumn } from "./RefsColumn";
import styles from "./RefsColumn.module.css";
import { REFS_SECTIONS } from "./refsLayout";

vi.mock("@tanstack/react-virtual", () => import("../test/mockVirtualizer"));

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
  checkoutBranch: vi.fn(),
  hostingListIssues: vi.fn(),
  hostingListPullRequests: vi.fn(),
  hostingRepoContext: vi.fn(),
  listBranches: vi.fn(),
  listLinkedWorktrees: vi.fn(),
  listRemotes: vi.fn(),
  listStashes: vi.fn(),
  listTags: vi.fn(),
  pullDefaultMode: vi.fn(),
}));

const branchList = (): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [
    {
      name: "main",
      oid: "a".repeat(40),
      isHead: true,
      tracking: { upstream: "origin/main", ahead: 0, behind: 0 },
      worktree: null,
    },
    { name: "feature", oid: "b".repeat(40), isHead: false, tracking: null, worktree: null },
  ],
  remotes: [],
});

// Records every observer and its targets; fire() delivers one batch shaped like the real API.
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }
  fire(entries: Array<{ target: Element; height: number }>) {
    this.callback(
      entries.map(
        ({ target, height }) => ({ target, contentRect: { height } }) as ResizeObserverEntry,
      ),
      this as never,
    );
  }
}

const observer = () => StubResizeObserver.instances[0] as StubResizeObserver;
const column = () => screen.getByTestId("refs-column");
// The measured container: the sections below the filter box.
const root = () => screen.getByTestId("refs-sections");
const wrapper = (s: string) => root().querySelector(`[data-section="${s}"]`) as HTMLElement;
const head = (s: string) => wrapper(s).querySelector("[data-section-head]") as HTMLElement;
const scroll = (s: string) => wrapper(s).querySelector("[data-section-scroll]") as HTMLElement;
const content = (s: string) => scroll(s)?.firstElementChild as HTMLElement;
const handle = (name: string) => screen.getByRole("separator", { name });

// Root 666 (= 636 + 5 handles of 6); naturals for local, remote, stashes, tags, worktrees,
// pullRequests, issues. Remote reports 0 here (no handle, no space), so every figure below keeps
// the value it had before the Local/Remote split; the Remote tests stub a non-zero natural.
const NATURALS = [200, 0, 60, 150, 36, 36, 36];
// Every head slot reports 0, so a section's natural (head plus content) equals its content.
const headEntries = (heights: number[] = REFS_SECTIONS.map(() => 0)) =>
  REFS_SECTIONS.map((s, i) => ({ target: head(s), height: heights[i] as number }));
const sectionEntries = () => [
  ...headEntries(),
  ...REFS_SECTIONS.map((s, i) => ({ target: content(s), height: NATURALS[i] as number })),
];

function measure() {
  act(() => observer().fire([{ target: root(), height: 666 }, ...sectionEntries()]));
}

function measureAt(rootHeight: number, heights: number[]) {
  act(() =>
    observer().fire([
      { target: root(), height: rootHeight },
      ...headEntries(),
      ...REFS_SECTIONS.map((s, i) => ({ target: content(s), height: heights[i] as number })),
    ]),
  );
}

// Without a hosting context the pull requests and issues panels render nothing, so they measure 0.
// Four handles render, so the container is 666 - 4 * 6 = 642.
function measureWithZeroHostingSections() {
  measureAt(666, [200, 0, 60, 150, 36, 0, 0]);
}

async function renderColumn() {
  const result = renderWithProviders(
    <RefsColumn repoId={1} onOpenRemotes={vi.fn()} onCreatePullRequest={null} />,
  );
  await screen.findByRole("region", { name: "Local branches" });
  return result;
}

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  StubResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  useWorkspace.setState({
    selected: {},
    selectedCommit: {},
    selectedStash: {},
    historyPath: {},
    centreView: {},
    refsFilter: {},
  });
  vi.mocked(listBranches).mockResolvedValue(branchList());
  vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin")]);
  vi.mocked(listStashes).mockResolvedValue([]);
  vi.mocked(listTags).mockResolvedValue({ tags: [], remotes: [] });
  vi.mocked(listLinkedWorktrees).mockResolvedValue([linkedWorktree()]);
  vi.mocked(pullDefaultMode).mockResolvedValue("merge");
  vi.mocked(hostingRepoContext).mockResolvedValue(null);
  vi.mocked(hostingListPullRequests).mockResolvedValue([]);
  vi.mocked(hostingListIssues).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Contract: seven sections in column order with six labelled horizontal handles between them.
describe("RefsColumn structure", () => {
  it("should render the seven sections in order with six horizontal handles between them", async () => {
    await renderColumn();
    const sections = [...root().querySelectorAll("[data-section]")].map((e) =>
      e.getAttribute("data-section"),
    );
    expect(sections).toEqual([
      "local",
      "remote",
      "stashes",
      "tags",
      "worktrees",
      "pullRequests",
      "issues",
    ]);
    const handles = screen.getAllByRole("separator");
    expect(handles.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Resize Local section",
      "Resize Remote section",
      "Resize Stashes section",
      "Resize Tags section",
      "Resize Worktrees section",
      "Resize Pull requests section",
    ]);
    for (const h of handles) expect(h).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("should render the Worktrees panel in the worktrees wrapper", async () => {
    await renderColumn();
    expect(
      await within(wrapper("worktrees")).findByRole("button", { name: "Worktrees (1)" }),
    ).toBeInTheDocument();
  });
});

// Contract (spec: Filter box): one filter box above every section, bound to the repo's refsFilter.
describe("RefsColumn filter box", () => {
  const filter = () => screen.getByRole("searchbox", { name: "Filter" });

  it("should render a Filter search box above the sections, outside the measured container", async () => {
    await renderColumn();
    expect(filter()).toHaveAttribute("placeholder", "Filter");
    expect(column().firstElementChild?.contains(filter())).toBe(true);
    expect(root().contains(filter())).toBe(false);
    expect(filter().closest("[data-section]")).toBeNull();
  });

  it("should write the typed text to the workspace store for the repo", async () => {
    const { user } = await renderColumn();
    await user.type(filter(), "fe");
    expect(useWorkspace.getState().refsFilter[1]).toBe("fe");
  });

  it("should show the repo's stored text and not another repo's", async () => {
    useWorkspace.getState().setRefsFilter(2, "other");
    await renderColumn();
    expect(filter()).toHaveValue("");
    act(() => useWorkspace.getState().setRefsFilter(1, "mine"));
    expect(filter()).toHaveValue("mine");
  });

  it("should clear the stored text on Escape", async () => {
    const { user } = await renderColumn();
    await user.type(filter(), "oth");
    await user.keyboard("{Escape}");
    expect(useWorkspace.getState().refsFilter[1]).toBe("");
    expect(filter()).toHaveValue("");
  });
});

// Contract: inline heights come from fitSections once the root and every section have reported.
describe("RefsColumn measurement", () => {
  it("should set no inline heights until the root and every section are measured", async () => {
    await renderColumn();
    act(() => observer().fire([{ target: root(), height: 666 }]));
    expect(wrapper("tags").style.height).toBe("");
  });

  it("should apply fitSections heights once measured", async () => {
    await renderColumn();
    measure();
    expect(wrapper("local").style.height).toBe("318px");
    expect(wrapper("tags").style.height).toBe("150px");
  });

  it("should apply fitted heights once every target has reported, even at zero", async () => {
    await renderColumn();
    measureWithZeroHostingSections();
    expect(wrapper("local").style.height).toBe("396px");
    expect(wrapper("tags").style.height).toBe("150px");
    expect(wrapper("worktrees").style.height).toBe("36px");
    expect(wrapper("pullRequests").style.height).toBe("0px");
  });

  it("should render no handle for a section measured at zero", async () => {
    await renderColumn();
    measureWithZeroHostingSections();
    expect(screen.queryByRole("separator", { name: "Resize Pull requests section" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize Remote section" })).toBeNull();
    for (const name of [
      "Resize Local section",
      "Resize Stashes section",
      "Resize Tags section",
      "Resize Worktrees section",
    ]) {
      expect(handle(name)).toBeInTheDocument();
    }
  });

  it("should ignore an entry for an unknown target", async () => {
    await renderColumn();
    act(() => observer().fire([{ target: document.body, height: 666 }, ...sectionEntries()]));
    expect(wrapper("tags").style.height).toBe("");
  });

  it("should ignore an entry without a target", async () => {
    await renderColumn();
    act(() =>
      observer().callback(
        [{ contentRect: { height: 666 } } as ResizeObserverEntry],
        observer() as never,
      ),
    );
    expect(wrapper("tags").style.height).toBe("");
  });

  it("should observe the sections container, the seven head slots and the seven content wrappers with one observer and disconnect on unmount", async () => {
    const { unmount } = await renderColumn();
    expect(StubResizeObserver.instances).toHaveLength(1);
    const targets = observer().observe.mock.calls.map(([t]) => t);
    expect(targets).toHaveLength(15);
    expect(new Set(targets)).toEqual(
      new Set([root(), ...REFS_SECTIONS.map(head), ...REFS_SECTIONS.map(content)]),
    );
    unmount();
    expect(observer().disconnect).toHaveBeenCalled();
  });

  it("should add a section's head height to its content when fitting", async () => {
    await renderColumn();
    // The same naturals as measure(), with 34 px of head on every section but Remote.
    act(() =>
      observer().fire([
        { target: root(), height: 666 },
        ...headEntries([34, 0, 34, 34, 34, 34, 34]),
        ...REFS_SECTIONS.map((s, i) => ({
          target: content(s),
          height: [166, 0, 26, 116, 2, 2, 2][i] as number,
        })),
      ]),
    );
    expect(wrapper("local").style.height).toBe("318px");
    expect(wrapper("tags").style.height).toBe("150px");
  });

  it("should set no inline heights while any head slot has not reported", async () => {
    await renderColumn();
    const report = (skip: string) =>
      act(() =>
        observer().fire([
          { target: root(), height: 666 },
          ...headEntries().filter((e) => skip === "" || e.target !== head(skip)),
          ...REFS_SECTIONS.map((s, i) => ({ target: content(s), height: NATURALS[i] as number })),
        ]),
      );
    report("worktrees");
    expect(wrapper("tags").style.height).toBe("");
    // Control: the same batch with every head reported does set heights.
    report("");
    expect(wrapper("tags").style.height).toBe("150px");
  });
});

// Contract: a handle shows the rendered height, the floor and the maximum, and edits the stored leaf.
describe("RefsColumn handles", () => {
  it("should give a handle the rendered height, floor and maximum", async () => {
    await renderColumn();
    measure();
    const tags = handle("Resize Tags section");
    expect(tags).toHaveAttribute("aria-valuenow", "150");
    expect(tags).toHaveAttribute("aria-valuemin", "72");
    expect(tags).toHaveAttribute("aria-valuemax", "150");
  });

  it("should bound the Local handle by the column, not its content", async () => {
    await renderColumn();
    measure();
    const branches = handle("Resize Local section");
    expect(branches).toHaveAttribute("aria-valuenow", "318");
    expect(branches).toHaveAttribute("aria-valuemax", "396");
  });

  it("should persist an ArrowDown on the Local handle", async () => {
    await renderColumn();
    measure();
    fireEvent.keyDown(handle("Resize Local section"), { key: "ArrowDown" });
    expect(useSettings.getState().settings.layout.branchesHeight).toBe(334);
  });

  it("should persist an ArrowUp on the Local handle", async () => {
    await renderColumn();
    measure();
    fireEvent.keyDown(handle("Resize Local section"), { key: "ArrowUp" });
    expect(useSettings.getState().settings.layout.branchesHeight).toBe(302);
  });

  it("should cap a handle's maximum at its section's content", async () => {
    await renderColumn();
    measure();
    expect(handle("Resize Stashes section")).toHaveAttribute("aria-valuemax", "60");
    expect(handle("Resize Tags section")).toHaveAttribute("aria-valuemax", "150");
  });

  it("should store nothing when a key press cannot move the handle", async () => {
    await renderColumn();
    measure();
    fireEvent.keyDown(handle("Resize Tags section"), { key: "ArrowDown" });
    expect(useSettings.getState().settings.layout.tagsHeight).toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("should ignore a key press before the column is measured", async () => {
    await renderColumn();
    fireEvent.keyDown(handle("Resize Tags section"), { key: "ArrowDown" });
    expect(useSettings.getState().settings.layout.tagsHeight).toBeNull();
  });

  it("should expose whole-pixel values", async () => {
    await renderColumn();
    // container 636; over 232 shared by room: local 400 - 263.14, tags 300 - 204.86
    measureAt(666, [400, 0, 60, 300, 36, 36, 36]);
    expect(wrapper("local").style.height).toBe("263px");
    expect(wrapper("tags").style.height).toBe("205px");
    expect(handle("Resize Local section")).toHaveAttribute("aria-valuenow", "263");
    expect(handle("Resize Tags section")).toHaveAttribute("aria-valuenow", "205");
  });

  it("should keep the inline heights when a batch changes nothing", async () => {
    await renderColumn();
    measure();
    const before = ["local", "stashes", "tags"].map((s) => wrapper(s).style.height);
    act(() => observer().fire([{ target: document.body, height: 999 }]));
    expect(["local", "stashes", "tags"].map((s) => wrapper(s).style.height)).toEqual(before);
  });

  it("should persist an ArrowUp resize to the section's height leaf", async () => {
    await renderColumn();
    // container 1012: everything fits, so Tags renders at its natural 300
    measureAt(1042, [200, 0, 60, 300, 36, 36, 36]);
    fireEvent.keyDown(handle("Resize Tags section"), { key: "ArrowUp" });
    expect(useSettings.getState().settings.layout.tagsHeight).toBe(284);
  });

  it("should reset the section to automatic on double-click", async () => {
    await seedSettings({ layout: { tagsHeight: 120 } });
    await renderColumn();
    measure();
    fireEvent.doubleClick(handle("Resize Tags section"));
    expect(useSettings.getState().settings.layout.tagsHeight).toBeNull();
  });

  it("should render a stored height through fitSections", async () => {
    await seedSettings({ layout: { tagsHeight: 120 } });
    await renderColumn();
    measure();
    expect(wrapper("tags").style.height).toBe("120px");
    expect(wrapper("local").style.height).toBe("348px");
  });
});

// Contract (GR-58): Local absorbs the leftover while open, else an open Remote, else nothing.
// Remote's natural is stubbed non-zero, so it has a handle: six handles, container = root - 36.
describe("RefsColumn Local and Remote", () => {
  it("should give the leftover to an open Local and show Remote at its content", async () => {
    await renderColumn();
    // container 736: 736 - (100 + 60 + 150 + 36 * 3) = 318 for Local
    measureAt(772, [200, 100, 60, 150, 36, 36, 36]);
    expect(wrapper("local").style.height).toBe("318px");
    expect(wrapper("remote").style.height).toBe("100px");
    expect(handle("Resize Remote section")).toHaveAttribute("aria-valuemax", "100");
  });

  it("should give the leftover to Remote when Local is collapsed", async () => {
    await seedSettings({ layout: { localCollapsed: true } });
    await renderColumn();
    // container 736: 736 - (28 + 60 + 150 + 36 * 3) = 390 for Remote
    measureAt(772, [28, 100, 60, 150, 36, 36, 36]);
    expect(wrapper("local").style.height).toBe("28px");
    expect(wrapper("remote").style.height).toBe("390px");
    // the absorbing Remote is bounded by the column (736 less the other floors), not its content
    expect(handle("Resize Remote section")).toHaveAttribute("aria-valuemax", "468");
    expect(handle("Resize Local section")).toHaveAttribute("aria-valuemax", "28");
  });

  it("should render a stored Remote height as a true height while Remote absorbs", async () => {
    await seedSettings({ layout: { localCollapsed: true, remoteHeight: 120 } });
    await renderColumn();
    // above its 100 px content, and the leftover stays unassigned (as a stored Local height does)
    measureAt(772, [28, 100, 60, 150, 36, 36, 36]);
    expect(wrapper("remote").style.height).toBe("120px");
    expect(wrapper("local").style.height).toBe("28px");
    expect(handle("Resize Remote section")).toHaveAttribute("aria-valuenow", "120");
  });

  it("should cap a collapsed Local's stored height at its content", async () => {
    await seedSettings({ layout: { localCollapsed: true, branchesHeight: 300 } });
    await renderColumn();
    measureAt(772, [28, 100, 60, 150, 36, 36, 36]);
    expect(wrapper("local").style.height).toBe("28px");
    expect(wrapper("remote").style.height).toBe("390px");
  });

  it("should leave the leftover unassigned when Local and Remote are both collapsed", async () => {
    await seedSettings({ layout: { localCollapsed: true, remoteCollapsed: true } });
    await renderColumn();
    measureAt(772, [28, 28, 60, 150, 36, 36, 36]);
    expect(wrapper("local").style.height).toBe("28px");
    expect(wrapper("remote").style.height).toBe("28px");
    expect(wrapper("tags").style.height).toBe("150px");
  });

  it("should render a stored Remote height while Local absorbs", async () => {
    await seedSettings({ layout: { remoteHeight: 120 } });
    await renderColumn();
    // container 736: Remote 120; Local 736 - (120 + 60 + 150 + 36 * 3) = 298
    measureAt(772, [200, 300, 60, 150, 36, 36, 36]);
    expect(wrapper("remote").style.height).toBe("120px");
    expect(wrapper("local").style.height).toBe("298px");
  });

  it("should persist an ArrowUp on the Remote handle to remoteHeight", async () => {
    await renderColumn();
    // container 1036: everything fits, so Remote renders at its natural 300
    measureAt(1072, [200, 300, 60, 150, 36, 36, 36]);
    fireEvent.keyDown(handle("Resize Remote section"), { key: "ArrowUp" });
    expect(useSettings.getState().settings.layout.remoteHeight).toBe(284);
    expect(useSettings.getState().settings.layout.branchesHeight).toBeNull();
  });
});

// Contract (spec: Panel errors and dialogs): the branch banner and dialogs are hosted once, at
// column level directly above Local and outside the measured sections.
describe("RefsColumn branch host block", () => {
  it("should render an action error once above Local, outside the measured sections", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue({
      kind: "checkoutFailed",
      message: "error: Your local changes would be overwritten",
    });
    const { user } = await renderColumn();
    await user.dblClick(await screen.findByTitle("refs/heads/feature"));
    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(root()).not.toContainElement(alert);
    expect(alert.compareDocumentPosition(root()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // collapsing Local leaves the banner in place
    await user.click(within(wrapper("local")).getByRole("button", { name: /^Local \(/ }));
    expect(screen.getByRole("alert")).toBe(alert);
  });

  it("should open the create dialog from New branch… in the Local header", async () => {
    const { user } = await renderColumn();
    await user.click(await within(wrapper("local")).findByRole("button", { name: "New branch…" }));
    expect(await screen.findByRole("dialog", { name: "New branch" })).toBeInTheDocument();
  });

  it("should render Local in the local wrapper and Remote in the remote wrapper", async () => {
    await renderColumn();
    expect(within(wrapper("local")).getByRole("region", { name: "Local branches" })).toBeVisible();
    expect(
      within(wrapper("remote")).getByRole("region", { name: "Remote branches" }),
    ).toBeVisible();
  });

  it("should write no remoteHeight while fitting with Local collapsed", async () => {
    await seedSettings({ layout: { localCollapsed: true } });
    await renderColumn();
    measureAt(772, [28, 100, 60, 150, 36, 36, 36]);
    measureAt(700, [28, 120, 60, 150, 36, 36, 36]);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(useSettings.getState().settings.layout.remoteHeight).toBeNull();
  });
});

// Contract: each section is a fixed head slot above a scrolling body; only the body scrolls.
describe("RefsColumn fixed headers", () => {
  it("should give every section a head slot then a scroll element holding one content wrapper", async () => {
    await renderColumn();
    for (const s of REFS_SECTIONS) {
      const children = [...wrapper(s).children];
      expect(children).toHaveLength(2);
      expect(children[0]).toHaveAttribute("data-section-head");
      expect(children[1]).toHaveAttribute("data-section-scroll");
      expect(children[1]?.children).toHaveLength(1);
    }
  });

  it("should render the stashes heading in the head slot, not the scroll element", async () => {
    await renderColumn();
    expect(head("stashes")).toBeInTheDocument();
    expect(scroll("stashes")).toBeInTheDocument();
    const heading = within(head("stashes")).getByRole("heading", { name: /^Stashes/ });
    expect(heading).toBeInTheDocument();
    expect(scroll("stashes").contains(heading)).toBe(false);
  });

  it.each([
    ["local", /^Local/],
    ["tags", /^Tags/],
    ["worktrees", /^Worktrees/],
  ])(
    "should render the %s collapse toggle in the head slot, not the scroll element",
    async (s, name) => {
      await renderColumn();
      expect(head(s)).toBeInTheDocument();
      expect(scroll(s)).toBeInTheDocument();
      const toggle = within(head(s)).getByRole("button", { name });
      expect(toggle).toBeInTheDocument();
      expect(scroll(s).contains(toggle)).toBe(false);
    },
  );

  it("should render New branch… and Create tag… in their head slots", async () => {
    await renderColumn();
    expect(head("local")).toBeInTheDocument();
    expect(head("tags")).toBeInTheDocument();
    expect(
      await within(head("local")).findByRole("button", { name: "New branch…" }),
    ).toBeInTheDocument();
    expect(within(head("tags")).getByRole("button", { name: "Create tag…" })).toBeInTheDocument();
  });

  it("should give every measured content wrapper the content class", async () => {
    await renderColumn();
    // Guard: an undefined class name must not make toHaveClass pass vacuously.
    expect(styles.content).toBeTruthy();
    for (const s of REFS_SECTIONS) expect(content(s)).toHaveClass(styles.content as string);
  });

  it("should render the Local branches list in Local's scroll element", async () => {
    await renderColumn();
    expect(scroll("local")).toBeInTheDocument();
    expect(within(scroll("local")).getByRole("region", { name: "Local branches" })).toBeVisible();
  });
});

// happy-dom applies no stylesheet, so the layout contract is pinned in the CSS source.
describe("RefsColumn.module.css", () => {
  const css = readFileSync("src/app/RefsColumn.module.css", "utf8");

  it("should make the measured content wrapper contain its children's margins", () => {
    expect(declarationsOf(css, "content")).toMatch(/display:\s*flow-root/);
  });

  it("should clip the section and not scroll it", () => {
    expect(declarationsOf(css, "section")).toMatch(/overflow:\s*hidden/);
    expect(declarationsOf(css, "section")).not.toMatch(/overflow:\s*auto/);
  });

  it("should not let the head slot shrink", () => {
    expect(declarationsOf(css, "head")).toMatch(/flex:\s*none/);
  });

  it("should scroll the body and let it shrink below its content", () => {
    expect(declarationsOf(css, "scroll")).toMatch(/overflow:\s*auto/);
    expect(declarationsOf(css, "scroll")).toMatch(/min-height:\s*0/);
  });
});
