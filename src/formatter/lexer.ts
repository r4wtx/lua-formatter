import { Comment } from "./ast";
import { FormatError } from "./errors";

export interface InterpPiece {
    kind: "text" | "expr";
    text: string;
    line: number;
    column: number;
}

export interface Token {
    type: string;
    value: string;
    line: number;
    column: number;
    endLine: number;
    commentsBefore: Comment[];
    blankLinesBefore: number;
    parts?: InterpPiece[];
}

export interface LexResult {
    shebang?: string;
    tokens: Token[];
}

const KEYWORDS = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then",
    "true", "until", "while",
]);

const MULTI_OPS = [
    "...", "..=", ">>=", "<<=", "//=",
    "<<", ">>", "<=", ">=", "==", "~=", "::",
    "+=", "-=", "*=", "/=", "%=", "^=", "&=", "|=",
    "//", "..", "->",
];

export interface LexOptions {
    baseLine?: number;
    baseColumn?: number;
    fragment?: boolean;
}

export function tokenize(source: string, lexOptions: LexOptions = {}): LexResult {
    return new Lexer(source, lexOptions).run();
}

class Lexer {
    private readonly s: string;
    private i = 0;
    private line: number;
    private column: number;
    private readonly fragment: boolean;

    constructor(source: string, options: LexOptions) {
        this.s = source;
        this.line = options.baseLine ?? 1;
        this.column = options.baseColumn ?? 1;
        this.fragment = options.fragment === true;
    }

    run(): LexResult {
        if (!this.fragment && this.s.charCodeAt(0) === 0xfeff) {
            this.advance();
        }
        let shebang: string | undefined;
        if (!this.fragment && this.s.startsWith("#!", this.i)) {
            const start = this.i;
            while (!this.eof() && this.char() !== "\n" && this.char() !== "\r") {
                this.advance();
            }
            shebang = this.s.slice(start, this.i);
        }

        const tokens: Token[] = [];
        while (!this.eof()) {
            const trivia = this.scanTrivia();
            if (this.eof()) {
                tokens.push(this.make("eof", "", trivia.comments, trivia.blankLines));
                break;
            }
            tokens.push(this.scanToken(trivia.comments, trivia.blankLines));
        }
        if (tokens.length === 0 || tokens[tokens.length - 1].type !== "eof") {
            tokens.push(this.make("eof", "", [], 0));
        }
        return { shebang, tokens };
    }

    private char(): string {
        return this.s[this.i] ?? "";
    }

    private eof(): boolean {
        return this.i >= this.s.length;
    }

    private peek(offset: number): string {
        return this.s[this.i + offset] ?? "";
    }

    private advance(): string {
        const c = this.s[this.i] ?? "";
        if (!c) {
            return "";
        }
        this.i++;
        if (c === "\n") {
            this.line++;
            this.column = 1;
        } else if (c === "\r") {
            if (this.char() === "\n") {
                this.i++;
            }
            this.line++;
            this.column = 1;
        } else {
            this.column++;
        }
        return c;
    }

    private scanTrivia(): { comments: Comment[]; blankLines: number } {
        const comments: Comment[] = [];
        let newlines = 0;
        while (!this.eof()) {
            if (this.char() === " " || this.char() === "\t" || this.char() === "\f" || this.char() === "\v") {
                this.advance();
                continue;
            }
            if (this.char() === "\n" || this.char() === "\r") {
                newlines++;
                this.advance();
                continue;
            }
            if (this.char() === "-" && this.peek(1) === "-") {
                const comment = this.scanComment(newlines);
                comments.push(comment);
                newlines = 0;
                continue;
            }
            break;
        }
        const blankLines = comments.length === 0 ? Math.max(0, newlines - 1) : 0;
        return { comments, blankLines };
    }

    private scanComment(newlinesBefore: number): Comment {
        const line = this.line;
        const start = this.i;
        this.advance();
        this.advance();
        if (this.char() === "[") {
            const long = this.tryConsumeLongBracket();
            if (long !== null) {
                return {
                    kind: "block",
                    text: this.s.slice(start, this.i),
                    line,
                    newlineBefore: newlinesBefore > 0,
                    extraBlankLines: Math.max(0, newlinesBefore - 1),
                };
            }
        }
        while (!this.eof() && this.char() !== "\n" && this.char() !== "\r") {
            this.advance();
        }
        return {
            kind: "line",
            text: this.s.slice(start, this.i),
            line,
            newlineBefore: newlinesBefore > 0,
            extraBlankLines: Math.max(0, newlinesBefore - 1),
        };
    }

    private scanToken(comments: Comment[], blankLines: number): Token {
        const startLine = this.line;
        const startCol = this.column;
        const ch = this.char();

        if (ch === "'" || ch === "\"") {
            const raw = this.readShortString();
            return this.finish("string", raw, startLine, startCol, comments, blankLines);
        }
        if (ch === "`") {
            return this.readBacktick(startLine, startCol, comments, blankLines);
        }
        if (ch === "[") {
            const long = this.tryConsumeLongBracket();
            if (long !== null) {
                return this.finish("longString", long, startLine, startCol, comments, blankLines);
            }
        }
        if (this.isIdentStart(ch)) {
            const start = this.i;
            this.advance();
            while (this.isIdentContinue(this.char())) {
                this.advance();
            }
            const word = this.s.slice(start, this.i);
            if (KEYWORDS.has(word)) {
                return this.finish("keyword", word, startLine, startCol, comments, blankLines);
            }
            return this.finish("ident", word, startLine, startCol, comments, blankLines);
        }
        if (this.isDigit(ch) || (ch === "." && this.isDigit(this.peek(1)))) {
            const raw = this.readNumber();
            return this.finish("number", raw, startLine, startCol, comments, blankLines);
        }

        for (const op of MULTI_OPS) {
            if (this.s.startsWith(op, this.i)) {
                for (let n = 0; n < op.length; n++) {
                    this.advance();
                }
                return this.finish(op, op, startLine, startCol, comments, blankLines);
            }
        }

        const single = "+-*/%^#&|~<>=(){}[];,.:?@";
        if (single.includes(ch)) {
            this.advance();
            return this.finish(ch, ch, startLine, startCol, comments, blankLines);
        }

        throw new FormatError(`unexpected character '${displayChar(ch)}'`, startLine, startCol);
    }

    private finish(type: string, value: string, line: number, column: number, comments: Comment[], blankLines: number, parts?: InterpPiece[]): Token {
        return {
            type,
            value,
            line,
            column,
            endLine: this.line,
            commentsBefore: comments,
            blankLinesBefore: blankLines,
            parts,
        };
    }

    private make(type: string, value: string, comments: Comment[], blankLines: number): Token {
        return {
            type,
            value,
            line: this.line,
            column: this.column,
            endLine: this.line,
            commentsBefore: comments,
            blankLinesBefore: blankLines,
        };
    }

    private readShortString(): string {
        const quote = this.char();
        const line = this.line;
        const column = this.column;
        const start = this.i;
        this.advance();
        while (!this.eof()) {
            if (this.char() === "\\" ) {
                this.advance();
                if (!this.eof()) {
                    this.advance();
                }
                continue;
            }
            if (this.char() === "\n" || this.char() === "\r") {
                throw new FormatError("unterminated string", line, column);
            }
            if (this.char() === quote) {
                this.advance();
                return this.s.slice(start, this.i);
            }
            this.advance();
        }
        throw new FormatError("unterminated string", line, column);
    }

    private readNumber(): string {
        const start = this.i;
        if (this.char() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
            this.advance();
            this.advance();
            this.readHexDigits();
            if (this.char() === ".") {
                this.advance();
                this.readHexDigits();
            }
            if (this.char() === "p" || this.char() === "P") {
                this.advance();
                if (this.char() === "+" || this.char() === "-") {
                    this.advance();
                }
                if (!this.isDigit(this.char())) {
                    throw new FormatError("malformed number", this.line, this.column);
                }
                while (this.isDigit(this.char())) {
                    this.advance();
                }
            }
            return this.s.slice(start, this.i);
        }
        if (this.char() === "0" && (this.peek(1) === "b" || this.peek(1) === "B")) {
            this.advance();
            this.advance();
            if (this.char() !== "0" && this.char() !== "1") {
                throw new FormatError("malformed number", this.line, this.column);
            }
            while (this.char() === "0" || this.char() === "1") {
                this.advance();
            }
            return this.s.slice(start, this.i);
        }
        if (this.char() === ".") {
            this.advance();
            while (this.isDigit(this.char())) {
                this.advance();
            }
        } else {
            while (this.isDigit(this.char())) {
                this.advance();
            }
            if (this.char() === ".") {
                this.advance();
                while (this.isDigit(this.char())) {
                    this.advance();
                }
            }
        }
        if (this.char() === "e" || this.char() === "E") {
            this.advance();
            if (this.char() === "+" || this.char() === "-") {
                this.advance();
            }
            if (!this.isDigit(this.char())) {
                throw new FormatError("malformed number", this.line, this.column);
            }
            while (this.isDigit(this.char())) {
                this.advance();
            }
        }
        return this.s.slice(start, this.i);
    }

    private readHexDigits(): void {
        const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
        while (isHex(this.char())) {
            this.advance();
        }
    }

    private readBacktick(line: number, column: number, comments: Comment[], blankLines: number): Token {
        const start = this.i;
        this.advance();
        const parts: InterpPiece[] = [];
        let textStart = this.i;
        let textLine = this.line;
        let textColumn = this.column;
        let hasExpr = false;
        while (!this.eof()) {
            if (this.char() === "\\") {
                this.advance();
                if (!this.eof()) {
                    this.advance();
                }
                continue;
            }
            if (this.char() === "`") {
                const text = this.s.slice(textStart, this.i);
                if (text.length > 0 || parts.length > 0) {
                    parts.push({ kind: "text", text, line: textLine, column: textColumn });
                }
                this.advance();
                if (!hasExpr) {
                    return this.finish("backtick", this.s.slice(start, this.i), line, column, comments, blankLines);
                }
                return this.finish("interp", this.s.slice(start, this.i), line, column, comments, blankLines, parts);
            }
            if (this.char() === "{") {
                const text = this.s.slice(textStart, this.i);
                if (text.length > 0) {
                    parts.push({ kind: "text", text, line: textLine, column: textColumn });
                }
                const exprLine = this.line;
                const exprColumn = this.column + 1;
                this.advance();
                const exprStart = this.i;
                this.skipNested(1);
                const exprText = this.s.slice(exprStart, this.i - 1);
                parts.push({ kind: "expr", text: exprText, line: exprLine, column: exprColumn });
                hasExpr = true;
                textStart = this.i;
                textLine = this.line;
                textColumn = this.column;
                continue;
            }
            this.advance();
        }
        throw new FormatError("unterminated backtick string", line, column);
    }

    private skipNested(depth: number): void {
        while (!this.eof() && depth > 0) {
            if (this.char() === "-" && this.peek(1) === "-") {
                this.advance();
                this.advance();
                if (this.char() === "[") {
                    const long = this.tryConsumeLongBracket();
                    if (long === null) {
                        while (!this.eof() && this.char() !== "\n" && this.char() !== "\r") {
                            this.advance();
                        }
                    }
                } else {
                    while (!this.eof() && this.char() !== "\n" && this.char() !== "\r") {
                        this.advance();
                    }
                }
                continue;
            }
            if (this.char() === "'" || this.char() === "\"") {
                this.readShortString();
                continue;
            }
            if (this.char() === "[") {
                const long = this.tryConsumeLongBracket();
                if (long === null) {
                    this.advance();
                }
                continue;
            }
            if (this.char() === "`") {
                this.readBacktick(this.line, this.column, [], 0);
                continue;
            }
            if (this.char() === "{") {
                depth++;
                this.advance();
                continue;
            }
            if (this.char() === "}") {
                depth--;
                this.advance();
                continue;
            }
            this.advance();
        }
        if (depth !== 0) {
            throw new FormatError("unterminated interpolation", this.line, this.column);
        }
    }

    private tryConsumeLongBracket(): string | null {
        if (this.char() !== "[") {
            return null;
        }
        let eqs = 0;
        let j = this.i + 1;
        while (this.s[j] === "=") {
            eqs++;
            j++;
        }
        if (this.s[j] !== "[") {
            return null;
        }
        const start = this.i;
        const line = this.line;
        const column = this.column;
        const close = "]" + "=".repeat(eqs) + "]";
        const contentStart = j + 1;
        const end = this.s.indexOf(close, contentStart);
        if (end < 0) {
            throw new FormatError("unterminated long bracket", line, column);
        }
        const endPos = end + close.length;
        while (this.i < endPos) {
            this.advance();
        }
        return this.s.slice(start, this.i);
    }

    private isDigit(c: string): boolean {
        return c >= "0" && c <= "9";
    }

    private isIdentStart(c: string): boolean {
        return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
    }

    private isIdentContinue(c: string): boolean {
        return this.isIdentStart(c) || this.isDigit(c) || c.charCodeAt(0) > 127;
    }
}

function displayChar(ch: string): string {
    if (ch === "") {
        return "end of file";
    }
    if (ch === "\n" || ch === "\r") {
        return "newline";
    }
    return ch;
}
