import { EMOJI_CODE } from "../emoji/pattern";

/**
 * Slack mrkdwn -> a small AST. Mirrors what Slack renders, including its
 * quirk that `*` `_` `~` only format at word boundaries (so they do not
 * work when glued to Japanese text unless `strict` is turned off).
 */

export type MentionKind = "user" | "channel" | "special" | "usergroup";

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "strike"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; url: string; label?: string }
  | { type: "mention"; kind: MentionKind; id?: string; label: string }
  | { type: "emoji"; name: string; skinTone?: number; raw: string }
  | { type: "br" };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "quote"; children: Block[] }
  | { type: "pre"; text: string };

export interface ParseOptions {
  /** Slack's boundary rule (default). When false, only ASCII letters/digits block emphasis. */
  strict?: boolean;
}

const EMPHASIS = { "*": "bold", _: "italic", "~": "strike" } as const;
type Marker = keyof typeof EMPHASIS;

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&" };
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ASCII_WORD = /[A-Za-z0-9]/;
const SPACE = /\s/;
const URL_RE = /https?:\/\/[!-;=?-~]+/y;
const URL_TRAILING = /[.,;:!?]+$/;
const EMOJI_RE = new RegExp(EMOJI_CODE, "y");
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\S+$/i;
const SPECIAL_MENTIONS = new Set(["here", "channel", "everyone"]);

export function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp);/g, (m) => ENTITIES[m]);
}

export function parseMrkdwn(src: string, opts: ParseOptions = {}): Block[] {
  const blocks: Block[] = [];
  for (const part of splitFences(src)) {
    const body = part.text.replace(/^\n/, "").replace(/\n$/, "");
    if (part.pre) blocks.push({ type: "pre", text: decodeEntities(body) });
    else if (body) blocks.push(...parseLines(body.split("\n"), opts));
  }
  return blocks;
}

function splitFences(src: string): { pre: boolean; text: string }[] {
  const parts: { pre: boolean; text: string }[] = [];
  let pos = 0;
  for (;;) {
    const open = src.indexOf("```", pos);
    if (open < 0) break;
    const close = src.indexOf("```", open + 3);
    if (close < 0) break;
    parts.push({ pre: false, text: src.slice(pos, open) }, { pre: true, text: src.slice(open + 3, close) });
    pos = close + 3;
  }
  parts.push({ pre: false, text: src.slice(pos) });
  return parts;
}

function parseLines(lines: string[], opts: ParseOptions): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: "paragraph", children: inlineLines(para, opts) });
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ type: "quote", children: [{ type: "paragraph", children: inlineLines(quote, opts) }] });
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rest = /^(?:>>>|&gt;&gt;&gt;) ?/.exec(line);
    if (rest) {
      flushPara();
      quote.push(line.slice(rest[0].length), ...lines.slice(i + 1));
      break;
    }
    const q = /^(?:>|&gt;) ?/.exec(line);
    if (q) {
      flushPara();
      quote.push(line.slice(q[0].length));
    } else {
      flushQuote();
      para.push(line);
    }
  }
  flushPara();
  flushQuote();
  return blocks;
}

function inlineLines(lines: string[], opts: ParseOptions): Inline[] {
  return lines.flatMap((line, i) => (i === 0 ? parseInline(line, opts) : [{ type: "br" } as Inline, ...parseInline(line, opts)]));
}

export function parseInline(s: string, opts: ParseOptions = {}): Inline[] {
  const strict = opts.strict ?? true;
  const out: Inline[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push({ type: "text", text: decodeEntities(buf) });
    buf = "";
  };
  const emit = (tok: Inline, next: number) => {
    flush();
    out.push(tok);
    i = next;
  };

  while (i < s.length) {
    const c = s[i];

    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        emit({ type: "code", text: decodeEntities(s.slice(i + 1, j)) }, j + 1);
        continue;
      }
    }

    if (c === "<") {
      const j = s.indexOf(">", i + 1);
      const tok = j > i ? parseAngle(s.slice(i + 1, j)) : null;
      if (tok) {
        emit(tok, j + 1);
        continue;
      }
    }

    if (c === "h" && isBoundary(s[i - 1], false)) {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(s);
      if (m) {
        const url = m[0].replace(URL_TRAILING, "");
        emit({ type: "link", url }, i + url.length);
        continue;
      }
    }

    if (c === ":") {
      EMOJI_RE.lastIndex = i;
      const m = EMOJI_RE.exec(s);
      if (m) {
        const tok: Inline = m[2]
          ? { type: "emoji", name: m[1], skinTone: Number(m[2]), raw: m[0] }
          : { type: "emoji", name: m[1], raw: m[0] };
        emit(tok, i + m[0].length);
        continue;
      }
    }

    if (isMarker(c) && isBoundary(s[i - 1], strict) && s[i + 1] !== undefined && !SPACE.test(s[i + 1])) {
      const j = findClose(s, i, c, strict);
      if (j > 0) {
        emit({ type: EMPHASIS[c], children: parseInline(s.slice(i + 1, j), opts) }, j + 1);
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

function isMarker(c: string): c is Marker {
  return c in EMPHASIS;
}

/** Line edges, whitespace and ASCII punctuation are boundaries; lenient mode adds every non-ASCII char. */
function isBoundary(ch: string | undefined, strict: boolean): boolean {
  if (ch === undefined || SPACE.test(ch) || ASCII_PUNCT.test(ch)) return true;
  return !strict && !ASCII_WORD.test(ch);
}

/** Finds the closing marker, skipping over code spans and <...> so markers inside them do not count. */
function findClose(s: string, open: number, marker: Marker, strict: boolean): number {
  for (let k = open + 1; k < s.length; k++) {
    const c = s[k];
    if (c === "`" || c === "<") {
      const j = s.indexOf(c === "`" ? "`" : ">", k + 1);
      if (j > k) {
        k = j;
        continue;
      }
    }
    if (c === marker && k > open + 1 && !SPACE.test(s[k - 1]) && isBoundary(s[k + 1], strict)) return k;
  }
  return -1;
}

function parseAngle(inner: string): Inline | null {
  const bar = inner.indexOf("|");
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? undefined : decodeEntities(inner.slice(bar + 1));
  const rest = target.slice(1);

  switch (target[0]) {
    case "@":
      if (!rest) return null;
      return SLACK_USER_ID.test(rest)
        ? { type: "mention", kind: "user", id: rest, label: label ?? rest }
        : { type: "mention", kind: "user", label: decodeEntities(rest) };
    case "#":
      return rest ? { type: "mention", kind: "channel", id: rest, label: label ?? rest } : null;
    case "!":
      if (SPECIAL_MENTIONS.has(rest)) return { type: "mention", kind: "special", label: rest };
      if (rest.startsWith("subteam^")) {
        const id = rest.slice("subteam^".length);
        return { type: "mention", kind: "usergroup", id, label: (label ?? id).replace(/^@/, "") };
      }
      return label !== undefined ? { type: "text", text: label } : null;
  }

  if (!URL_SCHEME.test(target)) return null;
  const url = decodeEntities(target);
  return label !== undefined ? { type: "link", url, label } : { type: "link", url };
}
