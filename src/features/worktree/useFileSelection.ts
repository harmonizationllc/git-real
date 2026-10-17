import { useState } from "react";

export interface ClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

export interface UseFileSelection {
  /** Read-only view of the selected keys; never mutate it. */
  selected: ReadonlySet<string>;
  click(key: string, modifiers: ClickModifiers): void;
  clear(): void;
  isSelected(key: string): boolean;
}

interface SelectionState {
  selected: Set<string>;
  anchor: string | null;
}

const EMPTY: SelectionState = { selected: new Set(), anchor: null };

// NUL cannot occur in a path, so the joined keys identify the list content unambiguously.
const signatureOf = (keys: string[]): string => keys.join("\0");

function prune(state: SelectionState, keys: string[]): SelectionState {
  const present = new Set(keys);
  const anchor = state.anchor !== null && present.has(state.anchor) ? state.anchor : null;
  const kept = [...state.selected].filter((k) => present.has(k));
  if (anchor === state.anchor && kept.length === state.selected.size) return state;
  return { selected: new Set(kept), anchor };
}

/**
 * Multi-selection over opaque keys in display order: plain click selects one, ctrl toggles,
 * shift selects the range from the anchor. Keys that leave `orderedKeys` are pruned.
 */
export function useFileSelection(orderedKeys: string[]): UseFileSelection {
  const [state, setState] = useState<SelectionState>(EMPTY);
  const signature = signatureOf(orderedKeys);
  const [seenSignature, setSeenSignature] = useState(signature);

  // Adjust state during render (not in an effect) so a stale selection is never shown.
  let current = state;
  if (signature !== seenSignature) {
    current = prune(state, orderedKeys);
    setSeenSignature(signature);
    if (current !== state) setState(current);
  }

  const click = (key: string, { ctrl, shift }: ClickModifiers) => {
    const index = orderedKeys.indexOf(key);
    if (index === -1) return;
    setState((prev) => {
      const anchorIndex = prev.anchor === null ? -1 : orderedKeys.indexOf(prev.anchor);
      if (shift && anchorIndex !== -1) {
        const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
        return { selected: new Set(orderedKeys.slice(from, to + 1)), anchor: prev.anchor };
      }
      if (ctrl && !shift) {
        const selected = new Set(prev.selected);
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        return { selected, anchor: key };
      }
      return { selected: new Set([key]), anchor: key };
    });
  };

  return {
    selected: current.selected,
    click,
    clear: () => setState(EMPTY),
    isSelected: (key) => current.selected.has(key),
  };
}
