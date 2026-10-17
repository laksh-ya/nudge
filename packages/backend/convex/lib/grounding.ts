/** The model may only repeat figures actually present in this turn's inputs and tool results. */
export function ungroundedNumbers(reply: string, sources: string[]): string[] {
  const numbers = (s: string) => [...s.matchAll(/(?<![\p{L}\p{N}])[-+]?\d[\d,]*(?:\.\d+)?(?![\p{L}\p{N}])/gu)].map((m) => m[0].replace(/,/g, ""));
  const allowed = new Set(sources.flatMap(numbers).map(Number));
  return numbers(reply).filter((n) => !Number.isFinite(Number(n)) || !allowed.has(Number(n)));
}
