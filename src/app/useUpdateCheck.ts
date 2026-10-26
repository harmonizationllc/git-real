import { useEffect } from "react";
import { checkForUpdate, openExternal } from "../lib/ipc";
import { useSettings } from "../lib/store/settings";
import { CHECK_INTERVAL_MS, STARTUP_DELAY_MS, useUpdateState } from "../lib/store/updateState";
import { useToasts } from "../lib/store/toasts";

/**
 * Checks for a newer release once per launch, `STARTUP_DELAY_MS` after mount, but
 * only when the user leaves it on and the last completed check is at least
 * `CHECK_INTERVAL_MS` old. A newer release raises a sticky info toast; failures
 * are swallowed. Either outcome marks the day checked so a broken network does
 * not retry on every launch. Unmount clears the pending timer.
 */
export function useUpdateCheck(): void {
  useEffect(() => {
    const { checkOnStartup } = useSettings.getState().settings.updates;
    const { lastCheckedAt } = useUpdateState.getState();
    if (!checkOnStartup) return;
    if (lastCheckedAt !== null && Date.now() - lastCheckedAt < CHECK_INTERVAL_MS) return;

    const timer = setTimeout(() => {
      void runStartupCheck();
    }, STARTUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}

async function runStartupCheck(): Promise<void> {
  try {
    const info = await checkForUpdate();
    useUpdateState.getState().markChecked(Date.now());
    if (info.available) {
      const url = info.url;
      useToasts.getState().notify({
        variant: "info",
        sticky: true,
        text: `Git Real ${info.latest} is available`,
        action: url !== null ? { label: "Release notes", run: () => void openExternal(url) } : null,
      });
    }
  } catch {
    // Failures are silent; still mark checked so we do not retry within the day.
    useUpdateState.getState().markChecked(Date.now());
  }
}
