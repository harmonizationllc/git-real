import { useMemo } from "react";
import { useSettings } from "../store/settings";
import { resolveBindings } from "./index";
import type { EffectiveBindings, ShortcutId } from "./index";

/** The effective bindings for React consumers, resolved once per change of the stored overrides. */
export function useEffectiveBindings(): EffectiveBindings {
  const bindings = useSettings((s) => s.settings.shortcuts.bindings);
  return useMemo(() => resolveBindings(bindings), [bindings]);
}

/** The effective chord for `id`, or `null` when unbound. */
export function useShortcutKeys(id: ShortcutId): string | null {
  return useEffectiveBindings()[id];
}
