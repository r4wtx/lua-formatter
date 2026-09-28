export type QuoteStyle = "preserve" | "single" | "double";
export type TrailingComma = "always" | "never" | "multiline";

export interface FormatOptions {
    indentSize: number;
    useTabs: boolean;
    semicolons: boolean;
    lineWidth: number;
    quoteStyle: QuoteStyle;
    trailingComma: TrailingComma;
    insertFinalNewline: boolean;
    eol: "\n" | "\r\n";
}

export const defaultOptions: FormatOptions = {
    indentSize: 4,
    useTabs: false,
    semicolons: true,
    lineWidth: 100,
    quoteStyle: "preserve",
    trailingComma: "multiline",
    insertFinalNewline: true,
    eol: "\n",
};

export function resolveOptions(partial: Partial<FormatOptions> = {}): FormatOptions {
    const merged: FormatOptions = { ...defaultOptions, ...partial };
    const indentSize = Math.floor(merged.indentSize);
    const lineWidth = Math.floor(merged.lineWidth);
    return {
        ...merged,
        indentSize: Number.isFinite(indentSize) ? Math.max(1, indentSize) : defaultOptions.indentSize,
        lineWidth: Number.isFinite(lineWidth) ? Math.max(20, lineWidth) : defaultOptions.lineWidth,
        eol: merged.eol === "\r\n" ? "\r\n" : "\n",
    };
}
