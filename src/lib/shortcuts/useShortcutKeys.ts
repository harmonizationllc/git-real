import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettings } from "../store/settings";
import { resolveBindings, validKeycaps } from "./index";
import type { ShortcutKeycaps } from "../ipc/types";
import type { EffectiveBindings, ShortcutId } from "./index";

/**
 * The effective bindings for React consumers, resolved once per change of the stored overrides.
 * Compared by value, since every save hands back fresh section objects.
 */
export function useEffectiveBindings(): EffectiveBindings {
  const bindings = useSettings(useShallow((s) => s.settings.shortcuts.bindings));
  return useMemo(() => resolveBindings(bindings), [bindings]);
}

/** The learned keycaps worth showing, validated once per change of the stored map. */
export function useKeycaps(): ShortcutKeycaps {
  const keycaps = useSettings(useShallow((s) => s.settings.shortcuts.keycaps));
  return useMemo(() => validKeycaps(keycaps), [keycaps]);
}

/** The effective chord for `id`, or `null` when unbound. */
export function useShortcutKeys(id: ShortcutId): string | null {
  return useEffectiveBindings()[id];
}
