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
    try {
      setDemoState(localStorage.getItem(KEY) === "1");
    } catch {}
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
