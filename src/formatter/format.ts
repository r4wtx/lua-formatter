import { parseChunk } from "./parser";
import { printChunk } from "./printer";
import { tokenize } from "./lexer";
import { FormatOptions, resolveOptions } from "./options";

export { FormatError } from "./errors";
export { defaultOptions, resolveOptions } from "./options";
export type { FormatOptions, QuoteStyle, TrailingComma } from "./options";

export function formatLua(source: string, partial: Partial<FormatOptions> = {}): string {
    const options = resolveOptions(partial);
    const lex = tokenize(source);
    const chunk = parseChunk(lex);
    return printChunk(chunk, options);
}
