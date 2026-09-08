/**
 * Client-side sanity check for subscription name-filter patterns.
 *
 * This is a UX guard only: the server always re-validates (and executes)
 * patterns with its own linear-time engine, so a pattern accepted here is
 * never trusted. The check deliberately avoids importing the worker's regex
 * engine — bundling the parser/compiler/Pike VM (~31 KB) into the dashboard
 * to validate a text field is not worth the payload.
 */

const MAX_PATTERN_LENGTH = 200;

export function validatePatternLocally(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "长度不能超过 " + MAX_PATTERN_LENGTH + " 个字符";
  if (/[*+?]\s*[*+?]/.test(pattern)) return "不支持连续的量词（如 a** 或 a+?）";
  if (/[*+?]\s*\{\d+,\s*\}/u.test(pattern)) return "不支持无上限的量词嵌套";
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of pairs) {
    if (countOf(pattern, open) !== countOf(pattern, close)) return "括号不匹配";
  }
  try {
    new RegExp(pattern);
  } catch {
    return "正则语法无效";
  }
  return null;
}

function countOf(value: string, character: string): number {
  let count = 0;
  for (const item of value) if (item === character) count += 1;
  return count;
}
