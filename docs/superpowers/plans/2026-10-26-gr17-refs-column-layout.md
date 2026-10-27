# GR-17 Refs Column Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The refs column shares its height by content with draggable, persisted section boundaries; graph ref pills show whole names plus a `+N` pill; the three remaining full-size error boxes use the compact panel variant.

**Architecture:** A pure `fitSections` in `src/app/refsLayout.ts` turns measured content heights and stored preferences into section heights; a new `RefsColumn` component measures with one `ResizeObserver`, renders the five panels in scrolling wrappers and puts a horizontal `SplitHandle` between them. Section heights are four nullable `u32` leaves in the Rust-owned `layout` settings section. `RefLabels` measures its pills and hides the trailing ones that do not fit, counted into the existing `+N` pill.

**Tech Stack:** React 19 + TypeScript (Vitest, Testing Library, jsdom), CSS modules, Rust 2024 `git-real-core` settings (serde), existing `SplitHandle` and settings store.

**Spec:** `docs/superpowers/specs/2026-10-26-gr17-refs-column-layout-design.md` (§3 column, §4 labels, §5 error boxes, §7 walk).

## Global Constraints

- No new crate or npm dependency (spec §2 anti-goal).
- `SECTION_MIN` / `SECTION_HEIGHT_MIN` is exactly `72`; `KEY_STEP` stays `16`; `SPLIT_HANDLE_WIDTH` stays `6`; `MAX_LABELS` stays `3`; `SUBJECT_RESERVE_PX = 64`; `MORE_PILL_PX = 36` (spec §3.1, §4).
- New settings leaves are `branchesHeight`, `stashesHeight`, `tagsHeight`, `pullRequestsHeight`, each `number | null`, default `null`; the shared fixture `src/lib/store/settingsDefaults.json` is the single source both test suites compare against (spec §3.3).
- Handle labels are exactly `Resize Branches section`, `Resize Stashes section`, `Resize Tags section`, `Resize Pull requests section` (spec §3.2).
- The only place that imports `@tauri-apps/api/core` is `src/lib/ipc` (project IPC seam rule); nothing here touches it.
- The developer never edits test files; tests come from the test role first (project TDD policy). Commits use explicit paths, no `add -A`, no amend/reset/stash (shared worktrees).
- Gate before the final review: `npm run lint`, `npm run typecheck`, `npm test`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check` (from `src-tauri`), front-end coverage still 100 %.

## Review Focus

1. **An older `settings.json` without the height leaves** must load with no warning and automatic heights; a stored `"tagsHeight": "300"` warns on `layout.tagsHeight` and falls back to `null`. Pinned in Task 1.
2. **A stored height on a section that is now collapsed or empty** (Tags collapsed, `tagsHeight: 300`): the section shows its header only, no blank body. Pinned in Task 5 (`fixed above natural clamps to natural`).
3. **A `ResizeObserver` entry for a detached or unknown target** (the RepoPane test stub fires entries without a target; a wrapper unmounted on tab switch): `RefsColumn` must ignore it rather than throw. Pinned in Task 6.
4. **A commit whose first ref name is wider than the whole budget**: one pill still shows (ellipsised by CSS), the rest count into `+N`; `fitLabels` never returns 0. Pinned in Task 7.
5. **Switching tabs while a section height is being dragged**: the column is keyed per tab, so the handle unmounts mid-drag; the stored value is whatever the last `onChange` sent and nothing else must fire. Not unit-testable beyond "no error on unmount"; covered by the walk in spec §7 step 3.

---

### Task 1: Section heights in the Rust settings

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/settings.rs:101-118` (`LayoutSettings`), `:300-311` (`LayoutPatch`), `:415-427` (`normalise`), `:575-600` (lenient `leaf` reads), `:683-692` (`apply`)
- Modify: `src/lib/store/settingsDefaults.json`
- Test: `src-tauri/crates/git-real-core/tests/settings.rs`

**Interfaces:**

- Consumes: `bounded`, `leaf`, `double_option`, `set` (exist in `settings.rs`).
- Produces: `pub const SECTION_HEIGHT_MIN: u32 = 72;` beside `REFS_MIN`; `LayoutSettings { branches_height, stashes_height, tags_height, pull_requests_height: Option<u32> }` (default `None`); `LayoutPatch` with the same four as `Option<Option<u32>>` (`double_option`, `skip_serializing_if = "Option::is_none"`); wire names `branchesHeight`, `stashesHeight`, `tagsHeight`, `pullRequestsHeight`.

- [ ] **Step 1: Write the failing tests** in `src-tauri/crates/git-real-core/tests/settings.rs`

```rust
#[test]
fn layout_section_heights_default_to_none() {
    let d = Settings::default();
    assert_eq!(d.layout.branches_height, None);
    assert_eq!(d.layout.stashes_height, None);
    assert_eq!(d.layout.tags_height, None);
    assert_eq!(d.layout.pull_requests_height, None);
    assert_eq!(git_real_core::settings::SECTION_HEIGHT_MIN, 72);
}

#[test]
fn lenient_section_heights_absent_null_wrong_type_and_small() {
    let (s, warnings) = Settings::from_json_lenient(&json!({"layout": {}}));
    assert_eq!(s.layout.tags_height, None);
    assert!(warnings.is_empty(), "{warnings:?}");

    let (s, warnings) = Settings::from_json_lenient(&json!({
        "layout": {"tagsHeight": null, "stashesHeight": "300", "branchesHeight": 10, "pullRequestsHeight": 200}
    }));
    assert_eq!(s.layout.tags_height, None);
    assert_eq!(s.layout.stashes_height, None);
    assert_eq!(s.layout.branches_height, Some(72));
    assert_eq!(s.layout.pull_requests_height, Some(200));
    let mut got = fields(&warnings);
    got.sort_unstable();
    assert_eq!(got, vec!["layout.branchesHeight", "layout.stashesHeight"]);
}

#[test]
fn patch_section_height_absent_keeps_null_clears_value_sets_and_clamps() {
    let mut base = Settings::default();
    base.layout.tags_height = Some(300);

    let kept = base.apply(&patch(json!({"layout": {"refsWidth": 250}}))).unwrap();
    assert_eq!(kept.layout.tags_height, Some(300));
    let cleared = base.apply(&patch(json!({"layout": {"tagsHeight": null}}))).unwrap();
    assert_eq!(cleared.layout.tags_height, None);
    let set = base.apply(&patch(json!({"layout": {"tagsHeight": 410}}))).unwrap();
    assert_eq!(set.layout.tags_height, Some(410));
    let small = base.apply(&patch(json!({"layout": {"branchesHeight": 5}}))).unwrap();
    assert_eq!(small.layout.branches_height, Some(72));
}

#[test]
fn section_heights_round_trip_through_the_file_codec() {
    let mut s = Settings::default();
    s.layout.stashes_height = Some(120);
    let text = serde_json::to_string_pretty(&SettingsFile::current(s.clone())).unwrap();
    assert!(text.contains("\"stashesHeight\": 120"), "{text}");
    assert!(text.contains("\"tagsHeight\": null"), "{text}");
    let (back, warnings) = SettingsFile::parse(&text).unwrap();
    assert_eq!(back, s);
    assert!(warnings.is_empty(), "{warnings:?}");
}
```

Also add the four `null` leaves to `src/lib/store/settingsDefaults.json` under `layout`, after `issuesCollapsed`, so `default_settings_equal_the_shared_fixture` stays the pin.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test -p git-real-core --test settings`
Expected: compile errors on the missing fields and constant.

- [ ] **Step 3: Implement** the constant, the four fields with `#[serde(default)]` semantics (the struct already has `default`), the four patch fields, the four `leaf` reads, the four `set` calls, and in `normalise` clamp each `Some(h)` to `SECTION_HEIGHT_MIN..=u32::MAX` through `bounded` with the field names `layout.branchesHeight` etc.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test -p git-real-core && cargo clippy --workspace -- -D warnings && cargo fmt --check`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/git-real-core/src/settings.rs src-tauri/crates/git-real-core/tests/settings.rs src/lib/store/settingsDefaults.json
git commit -m "feat(GR-17): persisted refs section heights in the layout settings"
```

---

### Task 2: Section heights across the IPC seam and the store

**Files:**

- Create: `src/app/refsLayout.ts` (types only in this task; Task 5 adds the maths)
- Modify: `src/lib/ipc/types.ts:145-151` (`Settings.layout`)
- Modify: `src/lib/store/settings.ts:22-28` (`DEFAULT_SETTINGS.layout`)
- Modify: `src/lib/store/settingsActions.ts`
- Modify: `src/lib/ipc/settings.test.ts:41-47` (the local `defaultSettings` copy: add the four `null` leaves so it type-checks)
- Test: `src/lib/store/settings.test.ts` (the `defaults equal the shared fixture` test already pins the shape), `src/lib/store/settingsActions.test.ts`

**Interfaces:**

- Produces in `src/app/refsLayout.ts`:
  `export const REFS_SECTIONS = ["branches", "stashes", "tags", "pullRequests", "issues"] as const;`
  `export type RefsSection = (typeof REFS_SECTIONS)[number];`
  `export type ResizableSection = Exclude<RefsSection, "issues">;`
- Produces in `settingsActions.ts`: `export function setSectionHeight(section: ResizableSection, height: number | null): void` → `setPref({ layout: { [`${section}Height`]: height === null ? null : Math.round(height) } })`.
- Produces in `types.ts`: `layout` gains `branchesHeight: number | null; stashesHeight: number | null; tagsHeight: number | null; pullRequestsHeight: number | null;`.

- [ ] **Step 1: Write the failing tests** in `src/lib/store/settingsActions.test.ts` (inside `describe("layout setters")`)

```ts
it("setSectionHeight rounds and saves the section's height leaf", async () => {
  actions.setSectionHeight("tags", 300.4);
  actions.setSectionHeight("branches", 199.6);
  expect(settings().layout).toMatchObject({ tagsHeight: 300, branchesHeight: 200 });
  expect(await patches()).toEqual([{ layout: { tagsHeight: 300, branchesHeight: 200 } }]);
});

it("setSectionHeight with null clears the leaf back to automatic", async () => {
  actions.setSectionHeight("pullRequests", 150);
  actions.setSectionHeight("pullRequests", null);
  expect(settings().layout.pullRequestsHeight).toBeNull();
  expect(await patches()).toEqual([{ layout: { pullRequestsHeight: null } }]);
});

it("the defaults carry four null section heights", () => {
  expect(DEFAULT_SETTINGS.layout).toMatchObject({
    branchesHeight: null,
    stashesHeight: null,
    tagsHeight: null,
    pullRequestsHeight: null,
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/store/settingsActions.test.ts src/lib/store/settings.test.ts`
Expected: FAIL (`setSectionHeight` is not a function; the fixture test fails until `DEFAULT_SETTINGS` matches the fixture Task 1 changed).

- [ ] **Step 3: Implement** the type, defaults, `refsLayout.ts` types and `setSectionHeight`. (The four leaves in the `defaultSettings` copy inside `src/lib/ipc/settings.test.ts` are the test role's edit, made in Step 1, since it is a test file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run src/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/refsLayout.ts src/lib/ipc/types.ts src/lib/ipc/settings.test.ts src/lib/store/settings.ts src/lib/store/settingsActions.ts src/lib/store/settingsActions.test.ts
git commit -m "feat(GR-17): section height leaves and setSectionHeight across the seam"
```

---

### Task 3: Compact error boxes (D)

**Files:**

- Modify: `src/features/tags/TagsPanel.tsx:184-186`
- Modify: `src/features/worktree/ChangesPanel.tsx:254`, `:259-261`
- Test: `src/features/tags/TagsPanel.test.tsx`, `src/features/worktree/ChangesPanel.test.tsx`

**Interfaces:** `RepoError` `variant?: "panel"` (exists; rendered as `data-variant`).

- [ ] **Step 1: Write the failing tests**

In `TagsPanel.test.tsx`, next to the existing `Copy name copies the tag name` test (reuse its setup; make `copyText` reject):

```ts
it("renders the copy error alert in the panel variant", async () => {
  vi.mocked(copyText).mockRejectedValue(new Error("clipboard closed"));
  // …open the row menu and click "Copy name" as the neighbouring test does…
  expect(await screen.findByRole("alert")).toHaveAttribute("data-variant", "panel");
});
```

In `ChangesPanel.test.tsx`, beside the `status exploded` test (line ~177) and the `nothing to do` action-failure test (line ~837):

```ts
it("renders the status error alert in the panel variant", async () => {
  // …same setup as the status error test…
  expect(await screen.findByRole("alert")).toHaveAttribute("data-variant", "panel");
});

it("renders the action error alert in the panel variant", async () => {
  // …same setup as the action failure test…
  expect(await screen.findByRole("alert")).toHaveAttribute("data-variant", "panel");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/tags/TagsPanel.test.tsx src/features/worktree/ChangesPanel.test.tsx`
Expected: the three new tests FAIL on the missing attribute.

- [ ] **Step 3: Implement**: add `variant="panel"` to the three `RepoError` elements.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command. Expected: PASS, including `should render the list error alert without a data-variant` (unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/features/tags/TagsPanel.tsx src/features/tags/TagsPanel.test.tsx src/features/worktree/ChangesPanel.tsx src/features/worktree/ChangesPanel.test.tsx
git commit -m "fix(GR-17): compact panel variant for the tags copy and changes error boxes"
```

---

### Task 4: Horizontal `SplitHandle`

**Files:**

- Modify: `src/components/SplitHandle.tsx`, `src/components/SplitHandle.module.css`
- Test: `src/components/SplitHandle.test.tsx`

**Interfaces:**

- Produces: `orientation?: "vertical" | "horizontal"` on `SplitHandleProps` (default `"vertical"`, every existing caller unchanged). Horizontal: `aria-orientation="horizontal"`, the pointer delta is `clientY`, `ArrowDown` = `+ sign * step`, `ArrowUp` = `− sign * step`, `ArrowLeft`/`ArrowRight` unhandled; inline `style={{ height: SPLIT_HANDLE_WIDTH }}` instead of `width`; class `styles.horizontal` added beside `styles.handle` (cursor `row-resize`, the 1 px line drawn top-to-bottom at 2–3 px).

- [ ] **Step 1: Write the failing tests** in `SplitHandle.test.tsx` (new `describe("SplitHandle horizontal")`, using the file's `renderHandle` helper with `orientation: "horizontal"`)

```ts
it("should expose aria-orientation horizontal", () => {
  const { handle } = renderHandle({ orientation: "horizontal" });
  expect(handle).toHaveAttribute("aria-orientation", "horizontal");
});

it("should set its height, not its width, from the handle size", () => {
  const { handle } = renderHandle({ orientation: "horizontal" });
  expect(handle.style.height).toBe("6px");
  expect(handle.style.width).toBe("");
});

it("should grow the value by step on ArrowDown and shrink it on ArrowUp", () => {
  const { handle, onChange } = renderHandle({ orientation: "horizontal" });
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  expect(onChange.mock.calls).toEqual([[316], [284]]);
});

it("should ignore ArrowRight when horizontal", () => {
  const { handle, onChange } = renderHandle({ orientation: "horizontal" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onChange).not.toHaveBeenCalled();
});

it("should follow the vertical pointer delta when horizontal", () => {
  const { handle, onChange } = renderHandle({ orientation: "horizontal" });
  fireEvent.pointerDown(handle, { clientX: 10, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 500, clientY: 140, pointerId: 1 });
  expect(onChange).toHaveBeenLastCalledWith(340);
});

it("should keep the vertical default when no orientation is given", () => {
  const { handle } = renderHandle();
  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  expect(handle.style.width).toBe("6px");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/SplitHandle.test.tsx`
Expected: the new tests FAIL (orientation ignored).

- [ ] **Step 3: Implement** the prop; pick the axis (`clientX`/`clientY`) and the key table from `orientation`; add the `.horizontal` rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command. Expected: PASS, every existing test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/components/SplitHandle.tsx src/components/SplitHandle.module.css src/components/SplitHandle.test.tsx
git commit -m "feat(GR-17): horizontal orientation for SplitHandle"
```

---

### Task 5: `fitSections` and `maxSectionHeight`

**Files:**

- Modify: `src/app/refsLayout.ts` (created in Task 2)
- Test: `src/app/refsLayout.test.ts`

**Interfaces:**

- Produces:
  `export const SECTION_MIN = 72;`
  `export interface SectionInput { natural: number; fixed: number | null }`
  `export function sectionFloor(natural: number): number` → `Math.min(SECTION_MIN, natural)`
  `export function fitSections(container: number, sections: SectionInput[]): number[]` (spec §3.1 steps 1–4; index 0 is Branches)
  `export function maxSectionHeight(container: number, sections: SectionInput[], index: number): number` → `container − Σ sectionFloor(natural of every other section)`; `Infinity` when `container <= 0`.

- [ ] **Step 1: Write the failing tests** in `src/app/refsLayout.test.ts`

```ts
const auto = (natural: number): SectionInput => ({ natural, fixed: null });
const fixed = (natural: number, fixed: number): SectionInput => ({ natural, fixed });

it("pins SECTION_MIN and the section order", () => {
  expect(SECTION_MIN).toBe(72);
  expect(REFS_SECTIONS).toEqual(["branches", "stashes", "tags", "pullRequests", "issues"]);
});

it("sectionFloor never pads a short section", () => {
  expect([sectionFloor(28), sectionFloor(72), sectionFloor(500)]).toEqual([28, 72, 72]);
});

it("gives the leftover to an automatic Branches when everything fits", () => {
  expect(fitSections(600, [auto(200), auto(60), auto(150), auto(36), auto(36)])).toEqual([
    318, 60, 150, 36, 36,
  ]);
});

it("leaves the leftover unassigned when Branches is fixed", () => {
  expect(fitSections(600, [fixed(400, 250), auto(60), auto(150), auto(36), auto(36)])).toEqual([
    250, 60, 150, 36, 36,
  ]);
});

it("shrinks automatic sections in proportion to their room above the floor", () => {
  // rooms 1000, 0, 500, 0, 0; over 750 → ratio 1/2
  expect(fitSections(1038, [auto(1072), auto(72), auto(572), auto(36), auto(36)])).toEqual([
    572, 72, 322, 36, 36,
  ]);
});

it("holds a fixed section while the automatic ones shrink", () => {
  expect(fitSections(1038, [auto(1072), auto(72), fixed(572, 400), auto(36), auto(36)])).toEqual([
    494, 72, 400, 36, 36,
  ]);
});

it("clamps a fixed height above the content to the content", () => {
  expect(fitSections(2000, [auto(100), auto(60), fixed(572, 900), auto(36), auto(36)])[2]).toBe(
    572,
  );
});

it("clamps a fixed height below the floor to the floor", () => {
  expect(fitSections(2000, [auto(100), auto(60), fixed(572, 10), auto(36), auto(36)])[2]).toBe(72);
});

it("shows a collapsed section at its header even with a stored height", () => {
  expect(fitSections(2000, [auto(100), auto(60), fixed(28, 300), auto(36), auto(36)])[2]).toBe(28);
});

it("takes from fixed sections once the automatic room is gone", () => {
  expect(fitSections(300, [auto(72), auto(72), fixed(572, 500), auto(36), auto(36)])).toEqual([
    72, 72, 84, 36, 36,
  ]);
});

it("keeps every floor when the floors alone overflow the container", () => {
  expect(fitSections(100, [auto(72), auto(72), auto(72), auto(36), auto(36)])).toEqual([
    72, 72, 72, 36, 36,
  ]);
});

it("passes the naturals through while unmeasured", () => {
  expect(fitSections(0, [auto(1072), auto(72), fixed(572, 100), auto(36), auto(36)])).toEqual([
    1072, 72, 572, 36, 36,
  ]);
});

it("maxSectionHeight is the container less the other floors, unbounded while unmeasured", () => {
  const s = [auto(1072), auto(72), auto(572), auto(36), auto(36)];
  expect(maxSectionHeight(1038, s, 0)).toBe(822);
  expect(maxSectionHeight(1038, s, 2)).toBe(822);
  expect(maxSectionHeight(0, s, 0)).toBe(Infinity);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/refsLayout.test.ts`
Expected: FAIL (functions missing).

- [ ] **Step 3: Implement** per spec §3.1. Proportional shrink: with `over` to remove and candidate rooms `r_i`, take `over * r_i / Σr` from each (if `over ≥ Σr`, take all of it and carry the remainder to the next class).

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/refsLayout.ts src/app/refsLayout.test.ts
git commit -m "feat(GR-17): fitSections shares the refs column by content"
```

---

### Task 6: `RefsColumn` and the pane integration

**Files:**

- Create: `src/app/RefsColumn.tsx`, `src/app/RefsColumn.module.css`
- Modify: `src/app/RepoPane.tsx:165-181` (render `<RefsColumn key={`refs-${tab.id}`} repoId={tab.id} onOpenRemotes={openRemotes} onCreatePullRequest={onCreatePullRequest} />` where the fragment of five panels is; the file-history branch is untouched)
- Modify: `src/app/RepoPane.module.css` (`.refs` keeps `display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: auto`)
- Modify: `src/features/branches/BranchesPanel.module.css:1-9` (drop `flex: 1`, `min-height: 0`, `overflow: auto`), `src/features/stash/StashesPanel.module.css:1-8`, `src/features/tags/TagsPanel.module.css:1-8`, `src/features/hosting/PullRequestsPanel.module.css:1-9`, `src/features/hosting/IssuesPanel.module.css:1-9` (each `.root` drops `flex`, `max-height`, `min-height`, `overflow`, `border-top`)
- Test: `src/app/RefsColumn.test.tsx`, `src/app/RepoPane.test.tsx:132-145, 394-396, 624-654`

**Interfaces:**

- Consumes: `fitSections`, `maxSectionHeight`, `sectionFloor`, `REFS_SECTIONS`, `ResizableSection` (Task 5); `setSectionHeight` (Task 2); `SplitHandle` with `orientation="horizontal"` (Task 4); `useSettings` layout leaves.
- Produces: `export interface RefsColumnProps { repoId: RepoId; onOpenRemotes(target: RemotesTarget): void; onCreatePullRequest: (() => void) | null }` and `export function RefsColumn(props): JSX.Element`.
- DOM contract: root `div` with `data-testid="refs-column"`; per section a wrapper `div` with `data-section="<RefsSection>"` and, once measured, inline `height: <px>` and `flex: none`; inside it a content `div` (the observed element) holding the panel; between sections a horizontal `SplitHandle` labelled per spec §3.2 (four handles).
- Measurement contract: one `ResizeObserver` per mount; `observe` called on the root and the five content wrappers; the callback reads `entry.target` and `entry.contentRect.height`, ignores unknown targets; container = root height − 4 × `SPLIT_HANDLE_WIDTH`; heights are applied only when the root and all five wrappers have reported > 0; `disconnect` on unmount.

- [ ] **Step 1: Write the failing tests** in `src/app/RefsColumn.test.tsx` (mock `../lib/ipc` as `RepoPane.test.tsx` does, with `listBranches`, `listStashes`, `listTags`, `hostingRepoContext` → `null`; stub `ResizeObserver` with a class that records `observe` targets and offers `fire(entries: Array<{ target: Element; height: number }>)`)

```ts
const wrapper = (s: string) => screen.getByTestId("refs-column").querySelector(`[data-section="${s}"]`) as HTMLElement;
const content = (s: string) => wrapper(s).firstElementChild as HTMLElement;
const handle = (name: string) => screen.getByRole("separator", { name });

it("renders the five sections in order with four horizontal handles between them", async () => {
  renderWithProviders(<RefsColumn repoId={1} onOpenRemotes={vi.fn()} onCreatePullRequest={null} />);
  await screen.findByRole("region", { name: "Branches" });
  const sections = [...screen.getByTestId("refs-column").querySelectorAll("[data-section]")].map((e) => e.getAttribute("data-section"));
  expect(sections).toEqual(["branches", "stashes", "tags", "pullRequests", "issues"]);
  const names = screen.getAllByRole("separator").map((h) => h.getAttribute("aria-label"));
  expect(names).toEqual(["Resize Branches section", "Resize Stashes section", "Resize Tags section", "Resize Pull requests section"]);
  for (const h of screen.getAllByRole("separator")) expect(h).toHaveAttribute("aria-orientation", "horizontal");
});

it("sets no inline heights until the root and every section are measured", async () => {
  /* render; fire root only */ expect(wrapper("tags").style.height).toBe("");
});

it("applies fitSections heights once measured", async () => {
  // root 624 (= 600 + 4*6), naturals 200, 60, 150, 36, 36 → 318, 60, 150, 36, 36
  expect(wrapper("branches").style.height).toBe("318px");
  expect(wrapper("tags").style.height).toBe("150px");
});

it("ignores an entry for an unknown target", async () => {
  /* fire with target: document.body */ expect(wrapper("tags").style.height).toBe("");
});

it("gives a handle the rendered height, floor and maximum", async () => {
  /* measured as above */
  expect(handle("Resize Tags section")).toHaveAttribute("aria-valuenow", "150");
  expect(handle("Resize Tags section")).toHaveAttribute("aria-valuemin", "72");
  expect(handle("Resize Tags section")).toHaveAttribute("aria-valuemax", String(600 - (72 + 60 + 36 + 36)));
});

it("persists a keyboard resize to the section's height leaf", async () => {
  fireEvent.keyDown(handle("Resize Tags section"), { key: "ArrowDown" });
  expect(useSettings.getState().settings.layout.tagsHeight).toBe(166);
});

it("resets the section to automatic on double-click", async () => {
  await seedSettings({ layout: { tagsHeight: 120 } });
  fireEvent.doubleClick(handle("Resize Tags section"));
  expect(useSettings.getState().settings.layout.tagsHeight).toBeNull();
});

it("renders a stored height through fitSections", async () => {
  await seedSettings({ layout: { tagsHeight: 120 } }); /* measure as above */
  expect(wrapper("tags").style.height).toBe("120px");
  expect(wrapper("branches").style.height).toBe("348px");
});

it("observes the root and the five content wrappers with one observer and disconnects on unmount", async () => {
  expect(StubResizeObserver.instances).toHaveLength(1);
  const targets = observer().observe.mock.calls.map(([t]) => t);
  expect(targets).toEqual([screen.getByTestId("refs-column"), ...REFS_SECTIONS.map(content)]);
  unmount();
  expect(observer().disconnect).toHaveBeenCalled();
});
```

Then in `RepoPane.test.tsx`: change `observer()` (line 396) to the instance whose `observe` was called with `body()`; change `should observe the body element with one observer` to assert exactly one instance observed `body()`; change `should keep the same observer across a tab change` to assert that instance is the same object and not disconnected after the rerender (the refs column is keyed per tab, so its own observer is recreated). The stub's `fire` keeps passing entries without a `target`; `RefsColumn` must ignore such entries (Review Focus 3).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/RefsColumn.test.tsx src/app/RepoPane.test.tsx`
Expected: `RefsColumn` tests FAIL (module missing); the two edited `RepoPane` tests FAIL until the column exists.

- [ ] **Step 3: Implement** `RefsColumn`, its CSS (`.column { display: flex; flex-direction: column; min-height: 0; height: 100% }`, `.section { flex: 0 1 auto; min-height: 0; overflow: auto }`), the `RepoPane` swap and the five panel CSS edits.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app src/features/branches src/features/stash src/features/tags src/features/hosting`
Expected: PASS; the branch filter, Tags collapse and panel tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app/RefsColumn.tsx src/app/RefsColumn.module.css src/app/RefsColumn.test.tsx src/app/RepoPane.tsx src/app/RepoPane.module.css src/app/RepoPane.test.tsx src/features/branches/BranchesPanel.module.css src/features/stash/StashesPanel.module.css src/features/tags/TagsPanel.module.css src/features/hosting/PullRequestsPanel.module.css src/features/hosting/IssuesPanel.module.css
git commit -m "feat(GR-17): RefsColumn shares the column by content with resizable sections"
```

---

### Task 7: Ref labels that fit (C)

**Files:**

- Create: `src/features/graph/model/refLabelFit.ts`
- Modify: `src/features/graph/RefLabels.tsx`, `src/features/graph/RefLabels.module.css`
- Test: `src/features/graph/model/refLabelFit.test.ts`, `src/features/graph/RefLabels.test.tsx`

**Interfaces:**

- Produces in `refLabelFit.ts`: `export const SUBJECT_RESERVE_PX = 64; export const MORE_PILL_PX = 36;` and `export function fitLabels(widths: number[], gap: number, budget: number, moreWidth: number): number` (spec §4; `widths` are the candidate pill widths, at most `MAX_LABELS` of them; the result is `1..widths.length`).
- `RefLabels` DOM: root `span` `flex: none; max-width: 100%; overflow: hidden`; candidate pills (first `min(refs.length, MAX_LABELS)`) always rendered, those beyond the fitted count carry `data-hidden="true"` (CSS `visibility: hidden; position: absolute`); the `+N` pill shows when `refs.length − shown > 0`, with `title` = hidden names joined by `\n` and `aria-label` = `` `${hidden.length} more: ${names.join(", ")}` ``; pills `max-width: 24ch`.
- Measurement: the root's `parentElement` is observed; budget = `parent.clientWidth − SUBJECT_RESERVE_PX − 6`; pill widths from `offsetWidth`; while the parent or any candidate measures `0`, every candidate shows. The `+N` pill's width is its `offsetWidth` when rendered and above `0`, else `MORE_PILL_PX` (jsdom measures `0`, so the tests use the constant).

- [ ] **Step 1: Write the failing tests**

`src/features/graph/model/refLabelFit.test.ts`:

```ts
it("shows every candidate when they all fit without the +N pill", () => {
  expect(fitLabels([40, 80, 40], 4, 170, 36)).toBe(3); // 168 ≤ 170
});
it("drops to two when the +N pill fits beside them", () => {
  expect(fitLabels([40, 80, 40], 4, 165, 36)).toBe(2); // 40+80+36+8 = 164
});
it("drops to one when two plus the pill do not fit", () => {
  expect(fitLabels([40, 80, 40], 4, 160, 36)).toBe(1);
});
it("never returns zero", () => {
  expect(fitLabels([400], 4, 10, 36)).toBe(1);
  expect(fitLabels([400, 50], 4, 10, 36)).toBe(1);
});
it("pins the reserve constants", () => {
  expect([SUBJECT_RESERVE_PX, MORE_PILL_PX]).toEqual([64, 36]);
});
```

`RefLabels.test.tsx` (new `describe("RefLabels fit")`; stub `ResizeObserver` recording the observed target with a `fire()`; set widths with `Object.defineProperty(el, "offsetWidth", { value })` on the pills and `clientWidth` on the parent):

```ts
it("observes its parent cell", () => {
  /* expect observe called with root.parentElement */
});
it("shows every pill while unmeasured", () => {
  /* three titles visible, no data-hidden */
});
it("hides trailing pills that do not fit and counts them into +N", () => {
  // parent 200 → budget 130; pills 40, 80, 40; "+2" ≈ 36 → fitLabels → 1
  expect(screen.getByTitle("b")).toHaveAttribute("data-hidden", "true");
  expect(screen.getByText("+2")).toHaveAttribute("aria-label", "2 more: b, c");
});
it("keeps a hidden pill's full name as its title", () => {
  /* getByTitle("b") exists */
});
it("counts labels beyond MAX_LABELS and labels that do not fit together", () => {
  // four refs, parent wide enough for two → "+2"
});
it("disconnects on unmount", () => {
  /* disconnect called */
});
```

Also tighten the existing CSS test: `should declare the pill rule non-shrinking` → `expect(rule(".pill")).toMatch(/flex:\s*none/)`, and add `expect(rule(".pill")).toMatch(/max-width:\s*24ch/)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/graph`
Expected: FAIL (module missing, no observer, old CSS).

- [ ] **Step 3: Implement** `fitLabels`, the measuring effect (`useLayoutEffect` + `ResizeObserver` on `rootRef.current.parentElement`, pill refs in an array, `useState` for the shown count, set only when it changes), the CSS (`.root`, `.pill[data-hidden="true"]`, `max-width: 24ch`, drop `min-width`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/graph && npm run typecheck`
Expected: PASS, every existing `RefLabels`, `GraphRow` and `GraphPanel` test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/features/graph/model/refLabelFit.ts src/features/graph/model/refLabelFit.test.ts src/features/graph/RefLabels.tsx src/features/graph/RefLabels.module.css src/features/graph/RefLabels.test.tsx
git commit -m "fix(GR-17): ref pills show whole names and overflow into +N"
```

---

### Task 8: Gate, walk notes and hand-off

- [ ] **Step 1: Run the full gate** (from the repo root, then `src-tauri`):

```bash
npm run lint && npm run typecheck && npm run test:coverage
cd src-tauri && cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --check
```

Expected: all green, coverage 100 %.

- [ ] **Step 2: Whole-branch review** by a fresh reviewer against the spec; fix findings; re-run the gate.

- [ ] **Step 3:** The owner runs the walk in spec §7 on the desktop; results go into the spec's §7 and the Jira ticket as a comment.

---

### Task 9: Post-review cleanup (owner-requested 2026-10-26)

**Files:**

- Modify: `src-tauri/crates/git-real-core/src/settings.rs` (`normalise`, the four section-height clamp blocks)
- Modify: `src/features/graph/model/layout.ts`, `src/features/graph/RefLabels.tsx`, `src/features/graph/RefLabels.module.css`, `src/features/graph/GraphRow.tsx`, `src/features/graph/GraphRow.module.css`
- Modify: `src/app/RepoPane.tsx` (the `key` on `RefsColumn`)
- Test: `src-tauri/crates/git-real-core/tests/settings.rs`, `src/features/graph/RefLabels.test.tsx`, `src/features/graph/GraphRow.test.tsx` (only if the inline gap needs a pin)

**Interfaces:**

- Rust: behaviour unchanged; the four clamp blocks collapse into one loop over `[(&mut self.layout.branches_height, "layout.branchesHeight"), …]` (or a small helper). New tests: patch clamps for `stashesHeight` and `pullRequestsHeight` (5 → 72) and a patch value of 0 → 72; the lenient-load test asserts the `layout.tagsHeight` and `layout.pullRequestsHeight` warning names.
- Label gaps: `export const LABEL_GAP_PX = 4;` and `export const MESSAGE_GAP_PX = 6;` in `src/features/graph/model/layout.ts`. `RefLabels` root gets inline `style={{ gap: LABEL_GAP_PX }}` and `GraphRow`'s `.message` cell gets inline `style={{ gap: MESSAGE_GAP_PX }}`; both `gap` declarations leave the CSS. `RefLabels` imports the two constants instead of its local 4 and 6. Budget stays `parent.clientWidth − SUBJECT_RESERVE_PX − MESSAGE_GAP_PX`.
- `+N` pill: no `aria-label`. Visible text stays `+N`; a nested `<span className={styles.srOnly}>` carries ` more: a, b` (leading space) so the pill's accessible name is `+2 more: b, c`. `.srOnly` is the usual clip rule (`position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap`). `title` unchanged (names joined by newline).
- `RepoPane.tsx`: remove the `key` prop from `<RefsColumn …>`; the keyed wrapper div stays.
- Label test gaps: a component test where the `+N` pill measures a non-zero width (lookup table gives `+2` → 60) and changes the result (e.g. cell 240 → budget 170: with pill 36, k = 2 (164 ≤ 170); with pill 60, 40+80+60+8 = 188 > 170 → k = 1); and a test with exactly three refs that all fit (no hidden pill, no `+N`).

- [ ] **Step 1 (test role):** write the tests above; RED for the Rust patch clamps is not expected (the behaviour exists), so those are pins; RED is expected for the warning-name assertions only if a name is wrong (they should pass), for the `+N` accessible-name test (no sr-only text today), for the `aria-label` absence test, for the non-zero `+N` width test (today's lookup gives 0), and for the CSS test that `.root` and `.message` no longer declare `gap` while `.srOnly` exists.
- [ ] **Step 2 (developer):** implement; `cargo test -p git-real-core`, `cargo clippy --workspace -- -D warnings`, `cargo fmt --check`, `npx vitest run src/features/graph src/app`, full `npx vitest run --coverage` (100 %), typecheck, eslint, prettier.
- [ ] **Step 3:** commit per role; one task review.
