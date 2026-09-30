import { EMOJI_CODE } from "./pattern";
import type { ResolvedEmoji } from "./resolver";

export interface EmojiMatch {
  from: number;
  to: number;
  emoji: ResolvedEmoji;
}

/** Ranges of `:emoji:` in plain note text that resolve; everything else (times, URLs) is left alone. */
export function findEmoji(text: string, resolve: (name: string, skinTone?: number) => ResolvedEmoji | null): EmojiMatch[] {
  const re = new RegExp(EMOJI_CODE, "g");
  const found: EmojiMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const emoji = resolve(m[1], m[2] ? Number(m[2]) : undefined);
    if (emoji) found.push({ from: m.index, to: m.index + m[0].length, emoji });
    // "10:30:tada:" first matches ":30:"; retry from its closing colon so ":tada:" is still found.
    else re.lastIndex = m.index + 1;
  }
  return found;
}
