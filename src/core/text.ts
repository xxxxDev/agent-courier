// What message text may hold. Words only, and nothing a person could not see in an
// approval question: no control characters, no format or default-ignorable characters
// (zero-width characters, word joiners, tags, variation selectors, bidirectional
// controls and the like), no private-use or unassigned code points, and not so many lines
// or blank lines that the end of a text is out of sight, and no more than 40 spaces or tabs
// in a row (the braille blank, U+2800, is refused as well). Ordinary emoji keep their variation
// selector (U+FE0F after a pictograph) and their joiners (U+200D between pictographs).

import { TEXT_OK } from "./ids.ts";
import { MAX_BLANK_RUN, MAX_LINES, TEXT_BYTES, TEXT_CHARS } from "./limits.ts";

const EMOJI_VS = /(?<=\p{Extended_Pictographic})\uFE0F/gu;
const EMOJI_ZWJ =
  /(?<=\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})/gu;
const INVISIBLE =
  /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;
/** Spaces (any kind) and tabs in a row: more could push text out of sight. */
const PADDING = /[\p{Zs}\t]{41,}/u;

export const lines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** Why this text cannot travel, or null when it can. */
export function textProblem(text: string): string | null {
  if (!/\S/.test(text)) return "text is empty";
  if (
    text.length > TEXT_CHARS ||
    Buffer.byteLength(JSON.stringify(text)) > TEXT_BYTES
  )
    return `text is too long: at most ${TEXT_CHARS} characters and ${TEXT_BYTES} bytes (about 4000 CJK characters)`;
  if (!TEXT_OK.test(text))
    return "text has control characters: only tabs and line breaks are allowed";
  if (INVISIBLE.test(text.replace(EMOJI_ZWJ, "").replace(EMOJI_VS, "")))
    return "text has invisible, blank or format characters (such as zero-width, joiner, tag, braille blank or bidirectional characters)";
  if (PADDING.test(text))
    return "text has more than 40 spaces or tabs in a row";
  const all = lines(text);
  if (all.length > MAX_LINES) return `text has more than ${MAX_LINES} lines`;
  let blank = 0;
  for (const line of all) {
    blank = /\S/.test(line) ? 0 : blank + 1;
    if (blank > MAX_BLANK_RUN)
      return `text has more than ${MAX_BLANK_RUN} blank lines in a row`;
  }
  return null;
}

/** How the approval question describes the text: characters (code points) and lines. */
export const textSize = (text: string): string => {
  const chars = [...text].length;
  const n = lines(text).length;
  return `${chars} character${chars === 1 ? "" : "s"}, ${n} line${n === 1 ? "" : "s"}`;
};
