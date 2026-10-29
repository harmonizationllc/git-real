import { shallow } from "zustand/shallow";
import { resolveBindings, setActiveBindings } from "../lib/shortcuts";
import { useSettings } from "../lib/store/settings";

/**
 * Pushes the resolved shortcut bindings into the module state `matchesShortcut` reads, now and
 * whenever the stored overrides change by value (every save hands back fresh section objects);
 * returns the uninstaller.
 */
export function bootstrapShortcuts(): () => void {
  setActiveBindings(resolveBindings(useSettings.getState().settings.shortcuts.bindings));
  return useSettings.subscribe((state, prev) => {
    if (!shallow(state.settings.shortcuts.bindings, prev.settings.shortcuts.bindings)) {
      setActiveBindings(resolveBindings(state.settings.shortcuts.bindings));
    }
  });
}
