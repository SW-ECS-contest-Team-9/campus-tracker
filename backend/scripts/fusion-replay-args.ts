// --set key=value parsing shared by fusion:replay and bench.
/** --set key=value: numbers and booleans are parsed, everything else stays a string. */
export function parseOverrides(sets: string[] | undefined): Record<string, unknown> | null {
  if (!sets?.length) return null;
  const out: Record<string, unknown> = {};
  for (const s of sets) {
    const i = s.indexOf('=');
    if (i <= 0) throw new Error(`--set expects key=value, got ${s}`);
    const raw = s.slice(i + 1);
    out[s.slice(0, i)] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}
