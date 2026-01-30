// Basic link extraction and normalization utilities.
// For production: consider a robust HTML parser and a proper URL extractor.

export function extractLinks(text: string): string[] {
  if (!text) return [];
  const regex = /https?:\/\/[^\s\]\)\}<>"']+/gi;
  const matches = text.match(regex) ?? [];
  // de-dupe
  return Array.from(new Set(matches.map(m => m.trim())));
}

export function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    // Remove common tracking noise
    u.hash = '';
    // Sort query params for stable uniqueness
    const params = Array.from(u.searchParams.entries());
    params.sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of params) {
      // keep everything; if you want, you can drop utm_* here
      u.searchParams.append(k, v);
    }
    // Normalize trailing slash
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return null;
  }
}
