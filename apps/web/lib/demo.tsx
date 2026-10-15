"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

const KEY = "aw-demo";
const DemoContext = createContext<{ demo: boolean; loaded: boolean; setDemo: (on: boolean) => void }>({
  demo: false,
  loaded: false,
  setDemo: () => {},
});

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [demo, setDemoState] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // /judge redirects here with ?demo=1 after setting its cookie.
    const fromLink = new URLSearchParams(window.location.search).get("demo") === "1";
    try {
      if (fromLink) localStorage.setItem(KEY, "1");
      setDemoState(fromLink || localStorage.getItem(KEY) === "1");
    } catch {
      setDemoState(fromLink);
    }
    if (fromLink) window.history.replaceState(null, "", window.location.pathname);
    setLoaded(true);
  }, []);
  const setDemo = useCallback((on: boolean) => {
    setDemoState(on);
    try {
      if (on) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {}
  }, []);
  return <DemoContext.Provider value={{ demo, loaded, setDemo }}>{children}</DemoContext.Provider>;
}

export const useDemo = () => useContext(DemoContext);
