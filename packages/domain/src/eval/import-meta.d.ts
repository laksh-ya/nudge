// Vite's import.meta.glob, used by the eval's Convex simulator to load backend modules.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
