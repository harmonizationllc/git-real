import { useEffect, useState } from "react";

const CLOCK_MS = 60_000;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The current time in Unix seconds, refreshed every minute; rows never read the clock. */
export function useNow(): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    // setNow receives nowSeconds as an updater on every tick.
    const timer = setInterval(setNow, CLOCK_MS, nowSeconds);
    return () => clearInterval(timer);
  }, []);
  return now;
}
