// Pure helpers for Hopper: meeting codes, names, chat text and the small message protocol
// that Hopper speaks over Freehop's room.send(). Everything that arrives from another
// browser is untrusted: it is checked and trimmed here before React renders it as text.

// Crockford base32 in lowercase: no i, l, o or u, so codes are easy to read aloud.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RAW_CODE = /^[0-9a-hjkmnp-tv-z]{20}$/;

/** 20 base32 characters (100 bits of randomness), shown as 4 groups of 5. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let raw = '';
  // 256 is a multiple of 32, so the low 5 bits of each byte are uniform.
  for (const b of bytes) raw += ALPHABET[b & 31];
  return group(raw);
}

const group = (raw: string) => raw.match(/.{5}/g)!.join('-');

/**
 * The meeting code in a typed code or a pasted link, or null. Accepts any case, spaces and
 * dashes, and the look-alike letters o, i and l for 0 and 1.
 */
export function parseCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  let text = input.trim();
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(hash + 1);
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  text = text.toLowerCase().replace(/[\s-]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
  return RAW_CODE.test(text) ? group(text) : null;
}

/** The code in the page's own fragment: a code, nothing at all, or something malformed. */
export function codeFromHash(hash: string): {code: string | null; malformed: boolean} {
  const raw = hash.replace(/^#/, '');
  if (!raw) return {code: null, malformed: false};
  const code = parseCode(raw);
  return {code, malformed: !code};
}

// Control characters, bidirectional overrides and invisible separators, by code point. Joiners
// stay, so emoji sequences and scripts that need them still render.
const UNSAFE: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function stripUnsafe(text: string, keepNewlines = false): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((keepNewlines && cp === 0x0a) || !UNSAFE.some(([from, to]) => cp >= from && cp <= to)) out += ch;
  }
  return out;
}

export const NAME_MAX = 40;
export const CHAT_MAX = 500;

/** A display name: no control characters, single spaces, at most 40 characters. */
export function cleanName(raw: unknown, {trim = true}: {trim?: boolean} = {}): string {
  if (typeof raw !== 'string') return '';
  let text = stripUnsafe(raw.slice(0, NAME_MAX * 8).replace(/\s/g, ' '));
  if (trim) text = text.replace(/ {2,}/g, ' ').trim();
  const capped = Array.from(text).slice(0, NAME_MAX).join('');
  return trim ? capped.trim() : capped;
}

/** A chat message: no control characters except line breaks, at most 500 characters. */
export function cleanChat(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = stripUnsafe(raw.slice(0, CHAT_MAX * 8).replace(/\r\n?/g, '\n'), true)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(text).slice(0, CHAT_MAX).join('').trim();
}

/** One or two letters for an avatar. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] ?? '?')[0] ?? '?';
  const second = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : '';
  return (first + second).toUpperCase();
}

export type HopperMessage =
  | {type: 'hello'; name: string | null; mic: boolean | null; cam: boolean | null}
  | {type: 'state'; mic: boolean | null; cam: boolean | null}
  | {type: 'chat'; text: string};

const flag = (value: unknown) => (typeof value === 'boolean' ? value : null);

/** Hopper's message shapes; anything else is ignored. */
export function parseMessage(data: unknown): HopperMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case 'hello':
      return {type: 'hello', name: cleanName(d.name) || null, mic: flag(d.mic), cam: flag(d.cam)};
    case 'state':
      return {type: 'state', mic: flag(d.mic), cam: flag(d.cam)};
    case 'chat': {
      const text = cleanChat(d.text);
      return text ? {type: 'chat', text} : null;
    }
    default:
      return null;
  }
}

/** A stable colour for someone's avatar, picked from the Freehop palette by their id. */
export function avatarTone(id: string): 'yellow' | 'azure' | 'coral' | 'white' {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (['yellow', 'azure', 'coral', 'white'] as const)[h % 4];
}

/** Reads and writes the remembered display name; storage can be missing or blocked. */
export const savedName = {
  read(): string {
    try {
      return cleanName(window.localStorage.getItem('hopper:name') ?? '');
    } catch {
      return '';
    }
  },
  write(name: string) {
    try {
      window.localStorage.setItem('hopper:name', cleanName(name));
    } catch {
      /* private mode or blocked storage: the name simply is not remembered */
    }
  },
};
