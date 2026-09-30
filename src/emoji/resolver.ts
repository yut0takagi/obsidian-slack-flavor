import standard from "./standard.json";

/** Workspace emoji as returned by Slack's emoji.list: name -> image url, or "alias:<name>". */
export type CustomEmojiMap = Record<string, string>;

export type ResolvedEmoji =
  | { kind: "custom"; name: string; url: string }
  | { kind: "unicode"; name: string; char: string };

export type EmojiResolver = (name: string, skinTone?: number) => ResolvedEmoji | null;

const STANDARD: Record<string, string> = standard.names;
const SKINS: Record<string, string[]> = standard.skins;
const MAX_ALIAS_DEPTH = 5;
const ALIAS_PREFIX = "alias:";

/**
 * Resolves an emoji name the way Slack does: workspace emoji first (following aliases),
 * then the standard set. `skinTone` is Slack's 2-6 (`:skin-tone-N:`).
 */
export function resolveEmoji(name: string, custom?: CustomEmojiMap, skinTone?: number): ResolvedEmoji | null {
  if (!name) return null;
  const exact = resolveAs(name, name, custom, skinTone, 0);
  if (exact || name === name.toLowerCase()) return exact;
  return resolveAs(name, name.toLowerCase(), custom, skinTone, 0);
}

function resolveAs(requested: string, name: string, custom: CustomEmojiMap | undefined, skinTone: number | undefined, depth: number): ResolvedEmoji | null {
  if (depth > MAX_ALIAS_DEPTH) return null;
  const value = custom?.[name];
  if (value !== undefined) {
    if (value.startsWith(ALIAS_PREFIX)) return resolveAs(requested, value.slice(ALIAS_PREFIX.length), custom, skinTone, depth + 1);
    return { kind: "custom", name: requested, url: value };
  }
  const char = STANDARD[name];
  if (char === undefined) return null;
  return { kind: "unicode", name: requested, char: withSkinTone(char, skinTone) };
}

function withSkinTone(char: string, skinTone: number | undefined): string {
  if (skinTone === undefined || skinTone < 2 || skinTone > 6) return char;
  return SKINS[char]?.[skinTone - 2] ?? char;
}

/** Candidates for autocomplete: workspace before standard, prefix before substring. */
export function searchEmoji(query: string, custom: CustomEmojiMap | undefined, limit: number): ResolvedEmoji[] {
  const q = query.toLowerCase();
  const buckets: string[][] = [[], [], [], []]; // custom-prefix, standard-prefix, custom-substring, standard-substring
  const seen = new Set<string>();
  const collect = (names: Iterable<string>, prefixBucket: number, substringBucket: number) => {
    for (const n of names) {
      if (seen.has(n)) continue;
      const lower = n.toLowerCase();
      const at = lower.indexOf(q);
      if (at < 0) continue;
      seen.add(n);
      buckets[at === 0 ? prefixBucket : substringBucket].push(n);
    }
  };
  collect(Object.keys(custom ?? {}), 0, 2);
  collect(Object.keys(STANDARD), 1, 3);

  const result: ResolvedEmoji[] = [];
  for (const bucket of buckets) {
    for (const n of bucket.sort(byLength)) {
      const resolved = resolveEmoji(n, custom);
      if (!resolved) continue;
      result.push(resolved);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function byLength(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}
