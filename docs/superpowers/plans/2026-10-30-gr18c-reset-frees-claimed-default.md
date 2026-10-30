# GR-18 Reset Frees a Claimed Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Reset` on a shortcut row also drops the other row's override that currently claims this row's default chord, so the pair returns to its defaults together and the row never ends up `Unbound` with nothing left to reset.

**Architecture:** One change in the `reset` handler of `ShortcutSettings.tsx`: after deleting the row's own entry, delete every other entry whose chord string equals this row's registry default. `resolveBindings` and the store are unchanged. The GR-18 spec's Saving paragraph and known-limits entry are corrected to match.

**Tech Stack:** React 19 + TypeScript, Vitest + Testing Library (existing `ShortcutSettings.test.tsx` helpers: `seed`, `setup`, `shortcuts`, `chordButton`, `kbdParts`).

**Spec:** `docs/superpowers/specs/2026-10-29-gr18-rebindable-shortcuts-design.md` §6 "Saving" and §7 "Known limits" (both amended in Task 1), §8 acceptance walk item 3 (unchanged: it already expects this behaviour).

**Why:** the 2026-10-30 acceptance walk on COSMIC found item 3 failing: after `Replace` gives Pull `Mod+K`, `Reset` on the Command palette row only deletes the palette entry; Pull's override still claims `Mod+K`, so the palette resolves to `Unbound` with no `Reset`, and `Ctrl+K` keeps pulling. §7 claimed the dialog never produces that state.

## Global Constraints

- Only `src/lib/ipc` imports `@tauri-apps/api/core`.
- Vitest coverage gate: 100 % on statements, branches, functions and lines.
- `npm run lint` (ESLint + Prettier) and `npm run typecheck` clean.
- No change to `settings.json` shape, Rust, or `resolveBindings`.
- Commits by explicit path only; author email `23158200+harmonizationllc@users.noreply.github.com`.

## Review Focus

1. A row whose default is claimed by two overrides at once (hand-edited file: impossible through the dialog, since one chord resolves to one id) — `Reset` drops every claimant, not just the first. Test pinned in Task 1 step 1 (third test).
2. `Reset` on a row with an unrelated override elsewhere leaves that override alone. Pinned in Task 1 step 1 (second test).
3. `Reset` on a row whose chord is `null` (explicitly unbound) with no claimant behaves as before: only its own entry goes. Covered by the existing "Reset deletes the entry" test.
4. Keycaps are untouched by the wider reset. Covered by the existing "Reset leaves keycaps alone" test plus the first new test's `keycaps: {}` assertion.
5. Focus still lands on the row's chord button. Covered by the existing focus test.

---

### Task 1: Reset drops the override that claims the row's default

**Files:**

- Modify: `src/features/settings/ShortcutSettings.tsx` (the `reset` handler, currently near line 156)
- Test: `src/features/settings/ShortcutSettings.test.tsx` (the `describe("ShortcutSettings reset")` block, near line 350)
- Modify: `docs/superpowers/specs/2026-10-29-gr18-rebindable-shortcuts-design.md` §6 Saving paragraph (near line 313) and §7 last known-limit bullet (near line 346)

**Interfaces:**

- Consumes: `shortcut(id).keys` from `src/lib/shortcuts` (already imported in the component as `shortcut`), `overrides` (`Record<ShortcutId, string | null>`), `commit({ bindings, keycaps })`, `focusChord(id)`.
- Produces: nothing new; `reset(id: ShortcutId): void` keeps its signature.

- [ ] **Step 1: Write the failing tests** (append inside `describe("ShortcutSettings reset")`)

```ts
it("Reset on a row whose default another override took drops that override too", async () => {
  await seed({ pull: "Mod+K", palette: null });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Reset Command palette to default" }));
  expect(await shortcuts()).toEqual({ bindings: {}, keycaps: {} });
  expect(kbdParts(chordButton("Command palette"))).toEqual(["Ctrl", "K"]);
  expect(kbdParts(chordButton("Pull"))).toEqual(["Ctrl", "Shift", "L"]);
});

it("Reset leaves overrides on other chords alone", async () => {
  await seed({ fetch: "Mod+Alt+F", pull: "Mod+K", palette: null });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Reset Command palette to default" }));
  expect(await shortcuts()).toEqual({ bindings: { fetch: "Mod+Alt+F" }, keycaps: {} });
});

it("Reset drops every override that claims the default (hand-edited file)", async () => {
  await seed({ pull: "Mod+K", push: "Mod+K", palette: null });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Reset Command palette to default" }));
  expect(await shortcuts()).toEqual({ bindings: {}, keycaps: {} });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/settings/ShortcutSettings.test.tsx -t "Reset"`
Expected: the three new tests FAIL on the `bindings` assertion (`pull: "Mod+K"` still present); the existing Reset tests PASS.

- [ ] **Step 3: Implement in `reset`**

Replace the body of `const reset = (id: ShortcutId) => { ... }` so that, after `delete bindings[id]`, it also deletes every `other` id in `bindings` whose value `=== shortcut(id).keys`. Then `commit({ bindings, keycaps })` and `focusChord(id)` as today. Update the handler's doc comment: "Restores the row's default; an override elsewhere that holds that chord goes too, so the row is never left unbound by its own reset."

- [ ] **Step 4: Run the file, then the full gate**

Run: `npx vitest run src/features/settings/ShortcutSettings.test.tsx`
Expected: all PASS.
Run: `npm run test:coverage 2>&1 | tail -15 && npm run lint && npm run typecheck`
Expected: 100 % on all four coverage metrics, 0 lint errors, tsc clean. Paste the raw summary lines in the report, not a filtered view.

- [ ] **Step 5: Amend the spec**

In §6 Saving, change "`Reset` deletes the id's entry." to: "`Reset` deletes the id's entry and any other id's entry that holds this id's default chord, so a row reset after a `Replace` gets its chord back and the row that took it returns to its own default."

In §7, replace the last bullet ("A row that is unbound only because another id's hand-edited override claimed its default shows `Unbound` with no `Reset`. The dialog never produces this state. Recovery is …") with: "A row that is unbound only because another id's **hand-edited** override claimed its default shows `Unbound` with no `Reset` (no entry of its own). The dialog never produces this state: `Reset` on a row after a `Replace` drops the claiming override too (found by the 2026-10-30 acceptance walk, item 3). Recovery for the hand-edited case is pressing the chord on that row and choosing `Replace`, `Reset` on the claiming row, or `Reset all`."

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/ShortcutSettings.tsx src/features/settings/ShortcutSettings.test.tsx docs/superpowers/specs/2026-10-29-gr18-rebindable-shortcuts-design.md docs/superpowers/plans/2026-10-30-gr18c-reset-frees-claimed-default.md
git commit -m "fix(GR-18): Reset also drops the override that claims the row's default"
```
