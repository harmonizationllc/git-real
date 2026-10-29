import { resolveBindings, setActiveBindings } from "../lib/shortcuts";
import { useSettings } from "../lib/store/settings";

/**
 * Pushes the resolved shortcut bindings into the module state `matchesShortcut` reads, now and
 * whenever the store's `shortcuts` section changes; returns the uninstaller.
 */
export function bootstrapShortcuts(): () => void {
  setActiveBindings(resolveBindings(useSettings.getState().settings.shortcuts.bindings));
  return useSettings.subscribe((state, prev) => {
    if (state.settings.shortcuts !== prev.settings.shortcuts) {
      setActiveBindings(resolveBindings(state.settings.shortcuts.bindings));
    }
  });
}
