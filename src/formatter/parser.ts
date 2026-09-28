import {
    Arguments,
    Block,
    Comment,
    Chunk,
    Expr,
    GenericParam,
    IfClause,
    LocalName,
    Param,
    Punctuated,
    Statement,
    TableField,
    TypeField,
    TypeFuncParam,
    TypeNode,
    emptyComments,
} from "./ast";
import { FormatError } from "./errors";
import { LexResult, Token, tokenize } from "./lexer";

const PREC: Record<string, number> = {
    "or": 1,
    "and": 2,
    "<": 3,
    ">": 3,
    "<=": 3,
    ">=": 3,
    "==": 3,
    "~=": 3,
    "|": 4,
    "~": 5,
    "&": 6,
    "<<": 7,
    ">>": 7,
    "..": 8,
    "+": 9,
    "-": 9,
    "*": 10,
    "/": 10,
    "//": 10,
    "%": 10,
    "^": 12,
};

const RIGHT_ASSOC = new Set(["..", "^"]);
const UNARY_PREC = 11;
const COMPOUND = new Set(["+=", "-=", "*=", "/=", "%=", "^=", "..=", "//=", "&=", "|=", "<<=", ">>="]);

export function parseChunk(lex: LexResult): Chunk {
    const parser = new Parser(lex.tokens);
    const chunk = parser.parseChunk();
    chunk.shebang = lex.shebang;
    return chunk;
}

export function parseExpressionSource(source: string, line: number, column: number): Expr {
    const lex = tokenize(source, { baseLine: line, baseColumn: column, fragment: true });
    const parser = new Parser(lex.tokens);
    const expr = parser.parseExpression();
    if (parser.peek().type !== "eof") {
        parser.fail(parser.peek(), "expected end of interpolation expression");
    }
    return expr;
}

class Parser {
    private tokens: Token[];
    private pos = 0;
    private held: Comment[] = [];
    private lastEndLine = 0;

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    parseChunk(): Chunk {
        const block = this.parseBlock();
        if (this.peek().type !== "eof") {
            this.fail(this.peek(), `unexpected token '${this.peek().value || this.peek().type}'`);
        }
        const eofComments = this.takeAll(this.peek().commentsBefore);
        const recovered = this.pullHeld();
        for (const token of this.tokens) {
            if (token.commentsBefore.length > 0) {
                recovered.push(...this.takeAll(token.commentsBefore));
            }
        }
        return {
            block,
            eofComments: [...eofComments, ...recovered],
        };
    }

    parseExpression(): Expr {
        return this.parseExpr(0);
    }

    fail(token: Token, message: string): never {
        throw new FormatError(message, token.line, token.column);
    }

    peek(offset = 0): Token {
        const index = this.pos + offset;
        if (index >= this.tokens.length) {
            return this.tokens[this.tokens.length - 1];
        }
        return this.tokens[index];
    }

    private parseBlock(): Block {
        const statements: Statement[] = [];
        while (!this.isBlockEnd()) {
            const stmt = this.parseStatement();
            statements.push(stmt);
            if (stmt.kind === "return" && !this.isBlockEnd()) {
                this.fail(this.peek(), "return must be the last statement in a block");
            }
        }
        if (this.peek().type === "eof") {
            return { statements, openComments: [], closeComments: [], closeBlankLines: 0 };
        }
        const closer = this.peek();
        const closeComments = this.takeAll(closer.commentsBefore);
        let closeBlankLines = 0;
        if (closeComments.length > 0) {
            closeBlankLines = Math.min(closeComments[0].extraBlankLines, 1);
            closeComments[0].extraBlankLines = 0;
        } else {
            closeBlankLines = Math.min(closer.blankLinesBefore, 1);
        }
        const held = this.pullHeld();
        return {
            statements,
            openComments: [],
            closeComments: [...held, ...closeComments],
            closeBlankLines,
        };
    }

    private parseStatement(): Statement {
        const lead = this.hoistLeading();
        const attributes: string[] = [];
        while (this.peek().type === "@") {
            this.consume();
            attributes.push(this.expectIdent().value);
        }
        const stmt = this.parseStatementBody();
        stmt.attributes = attributes;
        return this.finishStatement(stmt, lead);
    }

    private parseStatementBody(): Statement {
        const t = this.peek();
        if (t.type === ";") {
            return this.stub("empty");
        }
        if (t.type === "::") {
            this.consume();
            const name = this.expectIdent().value;
            this.expect("::");
            return { ...this.stub("label"), name };
        }
        if (t.type === "keyword") {
            switch (t.value) {
                case "break":
                    this.consume();
                    return this.stub("break");
                case "goto": {
                    this.consume();
                    const name = this.expectIdent().value;
                    return { ...this.stub("goto"), name };
                }
                case "do": {
                    const body = this.parseIntroBlock("do");
                    this.expectKeyword("end");
                    return { ...this.stub("do"), body };
                }
                case "while": {
                    this.consume();
                    const cond = this.parseExpr(0);
                    const body = this.parseIntroBlock("do");
                    this.expectKeyword("end");
                    return { ...this.stub("while"), cond, body };
                }
                case "repeat": {
                    this.consume();
                    const body = this.parseBlock();
                    this.expectKeyword("until");
                    const cond = this.parseExpr(0);
                    return { ...this.stub("repeat"), body, cond };
                }
                case "if":
                    return this.parseIf();
                case "for":
                    return this.parseFor();
                case "function":
                    return this.parseFunctionStatement();
                case "local":
                    return this.parseLocal();
                case "return":
                    return this.parseReturn();
                default:
                    break;
            }
        }
        if (this.isContinueStatement()) {
            this.consume();
            return this.stub("continue");
        }
        if (t.type === "ident" && t.value === "type") {
            if (this.looksLikeTypeFunction(0)) {
                return this.parseTypeFunction(false);
            }
            if (this.looksLikeTypeAlias(0)) {
                return this.parseTypeAlias(false);
            }
        }
        if (t.type === "ident" && t.value === "export" && this.peek(1).type === "ident" && this.peek(1).value === "type") {
            if (this.looksLikeTypeFunction(1)) {
                return this.parseTypeFunction(true);
            }
            if (this.looksLikeTypeAlias(1)) {
                return this.parseTypeAlias(true);
            }
        }
        const expr = this.parseAtomSuffix();
        if (this.peek().type === "," || this.peek().type === "=" || COMPOUND.has(this.peek().type)) {
            return this.parseAssignmentRest(expr);
        }
        if (expr.kind === "call" || expr.kind === "method") {
            return { ...this.stub("call"), expr };
        }
        this.fail(this.peek(), "expected assignment or function call");
    }

    private parseIf(): Statement {
        this.expectKeyword("if");
        const clauses: IfClause[] = [];
        for (;;) {
            const cond = this.parseExpr(0);
            const body = this.parseIntroBlock("then");
            clauses.push({ cond, body });
            if (this.peek().type === "keyword" && this.peek().value === "elseif") {
                this.consume();
                continue;
            }
            break;
        }
        let elseBody: Block | undefined;
        if (this.peek().type === "keyword" && this.peek().value === "else") {
            elseBody = this.parseIntroBlock("else");
        }
        this.expectKeyword("end");
        return { ...this.stub("if"), clauses, elseBody };
    }

    private parseFor(): Statement {
        this.expectKeyword("for");
        const first = this.parseForName();
        if (this.peek().type === "=") {
            this.consume();
            const start = this.parseExpr(0);
            this.expect(",");
            const stop = this.parseExpr(0);
            let step: Expr | undefined;
            if (this.consumeIf(",")) {
                step = this.parseExpr(0);
            }
            const body = this.parseIntroBlock("do");
            this.expectKeyword("end");
            return { ...this.stub("numericFor"), name: first.name, annotation: first.annotation, start, stop, step, body };
        }
        const names = [first];
        while (this.consumeIf(",")) {
            names.push(this.parseForName());
        }
        this.expectKeyword("in");
        const iters = this.parsePunctuated();
        const body = this.parseIntroBlock("do");
        this.expectKeyword("end");
        return { ...this.stub("genericFor"), names, iters, body };
    }

    private parseForName(): LocalName {
        const name = this.expectIdent().value;
        let annotation: TypeNode | undefined;
        if (this.consumeIf(":")) {
            annotation = this.parseType();
        }
        return { name, annotation };
    }

    private parseFunctionStatement(): Statement {
        this.expectKeyword("function");
        const path = [this.expectIdent().value];
        while (this.consumeIf(".")) {
            path.push(this.expectIdent().value);
        }
        let method: string | undefined;
        if (this.consumeIf(":")) {
            method = this.expectIdent().value;
        }
        const func = this.parseFunctionBody(this.emptyCommentsList());
        return { ...this.stub("function"), path, method, func };
    }

    private parseLocal(): Statement {
        this.expectKeyword("local");
        if (this.peek().type === "keyword" && this.peek().value === "function") {
            this.consume();
            const name = this.expectIdent().value;
            const func = this.parseFunctionBody(this.emptyCommentsList());
            return { ...this.stub("localFunction"), name, func };
        }
        const names = [this.parseLocalName()];
        while (this.consumeIf(",")) {
            if (this.peek().type !== "ident") {
                this.fail(this.peek(), "expected a name");
            }
            names.push(this.parseLocalName());
        }
        let values: Punctuated<Expr>[] = [];
        if (this.consumeIf("=")) {
            values = this.parsePunctuated();
        }
        return { ...this.stub("local"), names, values };
    }

    private parseLocalName(): LocalName {
        const name = this.expectIdent().value;
        let annotation: TypeNode | undefined;
        let attribute: string | undefined;
        if (this.consumeIf(":")) {
            annotation = this.parseType();
        }
        if (this.peek().type === "<" && this.peek(1).type === "ident" && this.isGtToken(this.peek(2))) {
            this.consume();
            attribute = this.expectIdent().value;
            this.consumeGt();
        }
        return { name, annotation, attribute };
    }

    private parseReturn(): Statement {
        this.expectKeyword("return");
        if (this.isBlockEnd() || this.peek().type === ";" || !this.isExprStart()) {
            return { ...this.stub("return"), values: [] };
        }
        return { ...this.stub("return"), values: this.parsePunctuated() };
    }

    private parseTypeAlias(exported: boolean): Statement {
        if (exported) {
            this.expectIdent();
        }
        this.expectIdent();
        const name = this.expectIdent().value;
        let generics: GenericParam[] | undefined;
        if (this.peek().type === "<") {
            generics = this.parseGenericParams();
        }
        this.expect("=");
        const valueBreak = this.brokeBefore();
        const value = this.parseType();
        return { ...this.stub("typeAlias"), exported, name, generics, value, valueBreak };
    }

    private parseTypeFunction(exported: boolean): Statement {
        if (exported) {
            this.expectIdent();
        }
        this.expectIdent();
        this.expectKeyword("function");
        const name = this.expectIdent().value;
        const func = this.parseFunctionBody(this.emptyCommentsList());
        return { ...this.stub("typeFunction"), exported, name, func };
    }

    private parseAssignmentRest(first: Expr): Statement {
        const targets: Punctuated<Expr>[] = [{ node: first, trailing: [], breakBefore: false }];
        while (this.consumeIf(",")) {
            targets[targets.length - 1].trailing = this.detachTrailing();
            const breakBefore = this.brokeBefore();
            const next = this.parseAtomSuffix();
            targets.push({ node: next, trailing: [], breakBefore });
        }
        if (targets.some((item) => !isLValue(item.node))) {
            this.fail(this.peek(), "expected a variable");
        }
        if (COMPOUND.has(this.peek().type)) {
            if (targets.length !== 1) {
                this.fail(this.peek(), "compound assignment takes one variable");
            }
            const op = this.consume().value;
            const valueBreak = this.brokeBefore();
            const value = this.parseExpr(0);
            return { ...this.stub("compound"), target: first, op, value, valueBreak };
        }
        this.expect("=");
        const values = this.parsePunctuated();
        return { ...this.stub("assign"), targets, values };
    }

    private parseIntroBlock(keyword: string): Block {
        this.expectKeyword(keyword);
        const openComments = [...this.pullHeld(), ...this.detachTrailing()];
        const body = this.parseBlock();
        body.openComments = openComments;
        return body;
    }

    private parseFunctionBody(comments: Comment[]): Extract<Expr, { kind: "function" }> {
        let generics: GenericParam[] | undefined;
        if (this.peek().type === "<") {
            generics = this.parseGenericParams();
        }
        this.expect("(");
        const params = this.parseParams();
        const paramsBroken = params.broken || this.brokeBefore();
        this.expect(")");
        let returnType: TypeNode | undefined;
        if (this.consumeIf(":")) {
            returnType = this.parseType();
        }
        const openComments = [...this.pullHeld(), ...this.detachTrailing()];
        const body = this.parseBlock();
        body.openComments = openComments;
        this.expectKeyword("end");
        return {
            kind: "function",
            generics,
            params: params.params,
            vararg: params.vararg,
            varargType: params.varargType,
            returnType,
            body,
            paramsBroken,
            commentsBefore: comments,
            commentsAfter: [],
        };
    }

    private parseParams(): { params: Param[]; vararg: boolean; varargType?: TypeNode; broken: boolean } {
        const params: Param[] = [];
        let broken = false;
        if (this.peek().type === ")") {
            return { params, vararg: false, broken: false };
        }
        for (;;) {
            if (this.brokeBefore()) {
                broken = true;
            }
            if (this.peek().type === "...") {
                this.consume();
                let varargType: TypeNode | undefined;
                if (this.consumeIf(":")) {
                    varargType = this.parseType();
                }
                return { params, vararg: true, varargType, broken };
            }
            const name = this.expectIdent().value;
            let annotation: TypeNode | undefined;
            if (this.consumeIf(":")) {
                annotation = this.parseType();
            }
            params.push({ name, annotation });
            if (!this.consumeIf(",")) {
                break;
            }
            if (this.peek().type === ")") {
                this.fail(this.peek(), "trailing comma is not allowed in a parameter list");
            }
        }
        return { params, vararg: false, broken };
    }

    private parseExpr(minPrec: number): Expr {
        let left = this.parseUnary();
        for (;;) {
            const op = this.binaryOp(this.peek());
            if (!op) {
                break;
            }
            const prec = PREC[op];
            if (prec < minPrec) {
                break;
            }
            const breakBefore = this.brokeBefore();
            this.consume();
            const breakAfter = this.brokeBefore();
            const opComments = this.pullHeld();
            const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
            const right = this.parseExpr(nextMin);
            left = { kind: "binary", op, left, right, opComments, breakBefore, breakAfter, ...emptyComments() };
        }
        return left;
    }

    private parseUnary(): Expr {
        const op = this.unaryOp(this.peek());
        if (!op) {
            return this.parseAtomSuffix();
        }
        const comments = this.beginNode();
        this.consume();
        const arg = this.parseExpr(UNARY_PREC);
        return { kind: "unary", op, arg, commentsBefore: comments, commentsAfter: [] };
    }

    private parseAtomSuffix(): Expr {
        return this.parseSuffixes(this.parseAtom());
    }

    private parseAtom(): Expr {
        const t = this.peek();
        if (t.type === "keyword" && t.value === "function") {
            const comments = this.beginNode();
            this.consume();
            return this.parseFunctionBody(comments);
        }
        if (t.type === "keyword" && t.value === "if") {
            const comments = this.beginNode();
            this.consume();
            return this.parseIfExpr(comments);
        }
        if (t.type === "keyword" && (t.value === "nil" || t.value === "true" || t.value === "false")) {
            const comments = this.beginNode();
            this.consume();
            return { kind: t.value, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "...") {
            const comments = this.beginNode();
            this.consume();
            return { kind: "vararg", commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "number") {
            const comments = this.beginNode();
            const raw = this.consume().value;
            return { kind: "number", raw, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "string") {
            const comments = this.beginNode();
            const raw = this.consume().value;
            return { kind: "string", raw, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "longString") {
            const comments = this.beginNode();
            const raw = this.consume().value;
            return { kind: "longString", raw, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "backtick") {
            const comments = this.beginNode();
            const raw = this.consume().value;
            return { kind: "backtick", raw, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "interp") {
            const comments = this.beginNode();
            const tok = this.consume();
            const parts = (tok.parts ?? []).map((part) => {
                if (part.kind === "text") {
                    return { kind: "text" as const, text: part.text };
                }
                return { kind: "expr" as const, expr: parseExpressionSource(part.text, part.line, part.column) };
            });
            return { kind: "interp", parts, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "ident") {
            const comments = this.beginNode();
            const name = this.consume().value;
            return { kind: "name", name, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "(") {
            const comments = this.beginNode();
            this.consume();
            const expr = this.parseExpr(0);
            this.expect(")");
            return { kind: "paren", expr, commentsBefore: comments, commentsAfter: [] };
        }
        if (t.type === "{") {
            const comments = this.beginNode();
            const table = this.parseTableFields();
            return { kind: "table", fields: table.fields, closeComments: table.closeComments, multiline: table.multiline, commentsBefore: comments, commentsAfter: [] };
        }
        this.fail(t, "expected an expression");
    }

    private parseIfExpr(comments: Comment[]): Expr {
        const clauses: { cond: Expr; body: Expr }[] = [];
        let multiline = false;
        const note = () => {
            if (this.brokeBefore()) {
                multiline = true;
            }
        };
        for (;;) {
            note();
            const cond = this.parseExpr(0);
            note();
            this.expectKeyword("then");
            note();
            const body = this.parseExpr(0);
            clauses.push({ cond, body });
            if (!(this.peek().type === "keyword" && this.peek().value === "elseif")) {
                break;
            }
            note();
            this.consume();
        }
        note();
        this.expectKeyword("else");
        note();
        const elseExpr = this.parseExpr(0);
        return { kind: "if", clauses, elseExpr, multiline, commentsBefore: comments, commentsAfter: [] };
    }

    private parseSuffixes(expr: Expr): Expr {
        for (;;) {
            const t = this.peek();
            if (t.type === ".") {
                this.consume();
                const name = this.expectIdent().value;
                expr = { kind: "field", object: expr, name, ...emptyComments() };
                continue;
            }
            if (t.type === "[") {
                this.consume();
                const index = this.parseExpr(0);
                this.expect("]");
                expr = { kind: "index", object: expr, index, ...emptyComments() };
                continue;
            }
            if (t.type === ":") {
                this.consume();
                const method = this.expectIdent().value;
                const typeArgs = this.peek().type === "<" ? this.tryTypeArgsBeforeCall() : undefined;
                const args = this.parseArgs();
                expr = { kind: "method", object: expr, method, args, typeArgs, ...emptyComments() };
                continue;
            }
            if (t.type === "(" || t.type === "{" || t.type === "string" || t.type === "longString" || t.type === "backtick" || t.type === "interp") {
                const args = this.parseArgs();
                expr = { kind: "call", callee: expr, args, ...emptyComments() };
                continue;
            }
            if (t.type === "<") {
                const call = this.tryGenericCall(expr);
                if (call) {
                    expr = call;
                    continue;
                }
                break;
            }
            if (t.type === "::") {
                if (this.peek(1).type === "ident" && this.peek(2).type === "::") {
                    break;
                }
                this.consume();
                const annotation = this.parseType();
                expr = { kind: "assertion", expr, annotation, ...emptyComments() };
                continue;
            }
            break;
        }
        return expr;
    }

    private tryGenericCall(callee: Expr): Expr | null {
        const snapPos = this.pos;
        const snapTokens = this.tokens;
        const snapHeld = this.held;
        const snapLine = this.lastEndLine;
        this.tokens = this.tokens.map((token) => ({ ...token, commentsBefore: [...token.commentsBefore] }));
        this.held = [...this.held];
        try {
            const typeArgs = this.parseTypeArgList();
            const next = this.peek().type;
            if (next !== "(" && next !== "{" && next !== "string" && next !== "longString" && next !== "backtick" && next !== "interp") {
                throw new FormatError("not a generic call", this.peek().line, this.peek().column);
            }
            const args = this.parseArgs();
            return { kind: "call", callee, args, typeArgs, ...emptyComments() };
        } catch (error) {
            this.pos = snapPos;
            this.tokens = snapTokens;
            this.held = snapHeld;
            this.lastEndLine = snapLine;
            if (error instanceof FormatError) {
                return null;
            }
            throw error;
        }
    }

    private tryTypeArgsBeforeCall(): TypeNode[] | undefined {
        const snapPos = this.pos;
        const snapTokens = this.tokens;
        const snapHeld = this.held;
        const snapLine = this.lastEndLine;
        this.tokens = this.tokens.map((token) => ({ ...token, commentsBefore: [...token.commentsBefore] }));
        this.held = [...this.held];
        try {
            const typeArgs = this.parseTypeArgList();
            const next = this.peek().type;
            if (next !== "(" && next !== "{" && next !== "string" && next !== "longString" && next !== "backtick" && next !== "interp") {
                throw new FormatError("not a generic call", this.peek().line, this.peek().column);
            }
            return typeArgs;
        } catch (error) {
            this.pos = snapPos;
            this.tokens = snapTokens;
            this.held = snapHeld;
            this.lastEndLine = snapLine;
            if (error instanceof FormatError) {
                return undefined;
            }
            throw error;
        }
    }

    private parseArgs(): Arguments {
        const t = this.peek();
        if (t.type === "(") {
            this.consume();
            const items = this.peek().type === ")" ? [] : this.parsePunctuated();
            if (items.length > 0) {
                items[items.length - 1].trailing.push(...this.detachTrailing());
            }
            const closeComments = this.peek().type === ")" ? this.takeAll(this.peek().commentsBefore) : [];
            this.expect(")");
            return { kind: "paren", items, closeComments };
        }
        if (t.type === "{") {
            return { kind: "table", table: this.parseAtom() };
        }
        if (t.type === "string" || t.type === "longString" || t.type === "backtick" || t.type === "interp") {
            return { kind: "string", expr: this.parseAtom() };
        }
        this.fail(t, "expected function arguments");
    }

    private parseTableFields(): { fields: TableField[]; closeComments: Comment[]; multiline: boolean } {
        const open = this.expect("{");
        const fields: TableField[] = [];
        while (this.peek().type !== "}" && this.peek().type !== "eof") {
            const field = this.parseField();
            if (this.peek().type === "," || this.peek().type === ";") {
                this.consume();
                field.trailing = this.detachTrailing();
                fields.push(field);
                continue;
            }
            fields.push(field);
            break;
        }
        if (fields.length > 0 && this.peek().type === "}") {
            fields[fields.length - 1].trailing.push(...this.detachTrailing());
        }
        const closeComments = this.peek().type === "}" ? this.takeAll(this.peek().commentsBefore) : [];
        const close = this.expect("}");
        return { fields, closeComments: [...this.pullHeld(), ...closeComments], multiline: close.line > open.line };
    }

    private parseField(): TableField {
        if (this.peek().type === "[") {
            const leading = this.beginNode();
            this.consume();
            const key = this.parseExpr(0);
            this.expect("]");
            this.expect("=");
            const value = this.parseExpr(0);
            return { kind: "index", key, value, trailing: [], leading };
        }
        if (this.peek().type === "ident" && this.peek(1).type === "=") {
            const leading = this.beginNode();
            const name = this.expectIdent().value;
            this.expect("=");
            const value = this.parseExpr(0);
            return { kind: "name", name, value, trailing: [], leading };
        }
        const leading = this.pullHeld();
        return { kind: "expr", value: this.parseExpr(0), trailing: [], leading };
    }

    private parsePunctuated(): Punctuated<Expr>[] {
        const firstBreak = this.brokeBefore();
        const items: Punctuated<Expr>[] = [{ node: this.parseExpr(0), trailing: [], breakBefore: firstBreak }];
        while (this.consumeIf(",")) {
            if (!this.isExprStart()) {
                this.fail(this.peek(), "expected expression after ','");
            }
            items[items.length - 1].trailing = this.detachTrailing();
            const breakBefore = this.brokeBefore();
            items.push({ node: this.parseExpr(0), trailing: [], breakBefore });
        }
        return items;
    }

    private parseType(): TypeNode {
        return this.parseUnionType();
    }

    private parseUnionType(): TypeNode {
        const options = [this.parseIntersectionType()];
        const breakBefore = [false];
        while (this.peek().type === "|") {
            const before = this.brokeBefore();
            this.consume();
            breakBefore.push(before || this.brokeBefore());
            options.push(this.parseIntersectionType());
        }
        return options.length === 1 ? options[0] : { kind: "union", options, breakBefore };
    }

    private parseIntersectionType(): TypeNode {
        const parts = [this.parseUnaryType()];
        const breakBefore = [false];
        while (this.peek().type === "&") {
            const before = this.brokeBefore();
            this.consume();
            breakBefore.push(before || this.brokeBefore());
            parts.push(this.parseUnaryType());
        }
        return parts.length === 1 ? parts[0] : { kind: "intersection", parts, breakBefore };
    }

    private parseUnaryType(): TypeNode {
        if (this.consumeIf("~")) {
            return { kind: "negation", base: this.parseUnaryType() };
        }
        return this.parsePostfixType();
    }

    private parsePostfixType(): TypeNode {
        let base = this.parseTypeAtom();
        while (this.consumeIf("?")) {
            base = { kind: "optional", base };
        }
        return base;
    }

    private parseTypeAtom(): TypeNode {
        const t = this.peek();
        if (t.type === "keyword" && t.value === "nil") {
            this.consume();
            return { kind: "nil" };
        }
        if (t.type === "keyword" && t.value === "true") {
            this.consume();
            return { kind: "true" };
        }
        if (t.type === "keyword" && t.value === "false") {
            this.consume();
            return { kind: "false" };
        }
        if (t.type === "string" || t.type === "longString") {
            const raw = this.consume().value;
            return { kind: "string", raw };
        }
        if (t.type === "...") {
            this.consume();
            if (this.isTypeAtomStart()) {
                return { kind: "variadic", base: this.parsePostfixType() };
            }
            return { kind: "variadic" };
        }
        if (t.type === "{") {
            return this.parseTableType();
        }
        if (t.type === "<") {
            const generics = this.parseGenericParams();
            const fn = this.parseFunctionType();
            fn.generics = generics;
            return fn;
        }
        if (t.type === "(") {
            return this.parseParenOrFunctionType();
        }
        if (t.type === "ident") {
            if (t.value === "typeof" && this.peek(1).type === "(") {
                this.consume();
                this.expect("(");
                const expr = this.parseExpr(0);
                this.expect(")");
                return { kind: "typeof", expr };
            }
            return this.parseTypeName();
        }
        this.fail(t, "expected a type");
    }

    private parseTypeName(): TypeNode {
        const parts = [this.expectIdent().value];
        while (this.peek().type === "." && this.peek(1).type === "ident") {
            this.consume();
            parts.push(this.expectIdent().value);
        }
        let typeArgs: TypeNode[] | undefined;
        if (this.peek().type === "<") {
            typeArgs = this.parseTypeArgList();
        }
        const pack = this.consumeIf("...");
        return { kind: "name", parts, typeArgs, pack };
    }

    private parseParenOrFunctionType(): TypeNode {
        this.expect("(");
        if (this.consumeIf(")")) {
            if (this.consumeIf("->")) {
                return { kind: "function", params: [], returnType: this.parseType() };
            }
            return { kind: "tuple", types: [] };
        }
        const elements = [this.parseTypeElement()];
        while (this.consumeIf(",")) {
            if (this.peek().type === ")") {
                this.fail(this.peek(), "trailing comma is not allowed in a type list");
            }
            elements.push(this.parseTypeElement());
        }
        this.expect(")");
        if (this.consumeIf("->")) {
            return { kind: "function", params: elements, returnType: this.parseType() };
        }
        if (elements.some((element) => element.name !== undefined)) {
            this.fail(this.peek(), "function type is missing '->'");
        }
        if (elements.length === 1) {
            return { kind: "paren", base: elements[0].type };
        }
        return { kind: "tuple", types: elements.map((element) => element.type) };
    }

    private parseFunctionType(): Extract<TypeNode, { kind: "function" }> {
        const node = this.parseParenOrFunctionType();
        if (node.kind !== "function") {
            this.fail(this.peek(), "expected a function type");
        }
        return node;
    }

    private parseTypeElement(): TypeFuncParam {
        if (this.peek().type === "ident" && this.peek(1).type === ":") {
            const name = this.expectIdent().value;
            this.consume();
            return { name, type: this.parseType() };
        }
        return { type: this.parseType() };
    }

    private parseTableType(): TypeNode {
        const open = this.expect("{");
        const fields: TypeField[] = [];
        while (this.peek().type !== "}" && this.peek().type !== "eof") {
            fields.push(this.parseTypeField());
            if (this.peek().type === "," || this.peek().type === ";") {
                this.consume();
                continue;
            }
            break;
        }
        const close = this.expect("}");
        return { kind: "table", fields, multiline: close.line > open.line };
    }

    private parseTypeField(): TypeField {
        let modifier: "read" | "write" | undefined;
        const t = this.peek();
        if (t.type === "ident" && (t.value === "read" || t.value === "write")) {
            const next = this.peek(1);
            if (next.type === "ident" || next.type === "[") {
                this.consume();
                modifier = t.value;
            }
        }
        if (this.peek().type === "[") {
            this.consume();
            const key = this.parseType();
            this.expect("]");
            this.expect(":");
            return { kind: "indexer", key, modifier, type: this.parseType() };
        }
        if (this.peek().type === "ident" && this.peek(1).type === ":") {
            const name = this.expectIdent().value;
            this.expect(":");
            return { kind: "prop", name, modifier, type: this.parseType() };
        }
        if (modifier) {
            this.fail(this.peek(), "expected a property name after '" + modifier + "'");
        }
        return { kind: "array", type: this.parseType() };
    }

    private parseGenericParams(): GenericParam[] {
        this.expect("<");
        const params: GenericParam[] = [];
        if (this.peek().type !== ">") {
            do {
                const name = this.expectIdent().value;
                const pack = this.consumeIf("...");
                let defaultType: TypeNode | undefined;
                if (this.consumeIf("=")) {
                    defaultType = this.parseType();
                }
                params.push({ name, pack, defaultType });
            } while (this.consumeIf(","));
        }
        this.consumeGt();
        return params;
    }

    private parseTypeArgList(): TypeNode[] {
        this.expect("<");
        const args: TypeNode[] = [];
        if (this.peek().type !== ">" && this.peek().type !== ">>") {
            do {
                args.push(this.parseType());
            } while (this.consumeIf(","));
        }
        this.consumeGt();
        return args;
    }

    private isGtToken(token: Token): boolean {
        return token.type === ">" || token.type === ">>" || token.type === ">=" || token.type === ">>=";
    }

    private consumeGt(): void {
        const token = this.peek();
        if (token.type === ">") {
            this.consume();
            return;
        }
        const rest = token.type === ">>" ? ">" : token.type === ">=" ? "=" : token.type === ">>=" ? ">=" : "";
        if (rest) {
            token.type = ">";
            token.value = ">";
            const extra: Token = {
                ...token,
                type: rest,
                value: rest,
                commentsBefore: [],
                blankLinesBefore: 0,
            };
            this.tokens.splice(this.pos + 1, 0, extra);
            this.consume();
            return;
        }
        this.fail(token, "expected '>'");
    }

    private isTypeAtomStart(): boolean {
        const t = this.peek();
        if (t.type === "ident" || t.type === "string" || t.type === "longString" || t.type === "(" || t.type === "{" || t.type === "<" || t.type === "...") {
            return true;
        }
        if (t.type === "keyword") {
            return t.value === "nil" || t.value === "true" || t.value === "false";
        }
        return false;
    }

    private stub<K extends Statement["kind"]>(kind: K): Statement & { kind: K } {
        return {
            kind,
            blankLinesBefore: 0,
            attributes: [],
            commentsBefore: [],
            commentsAfter: [],
        } as Statement & { kind: K };
    }

    private emptyCommentsList(): Comment[] {
        return [];
    }

    private finishStatement(stmt: Statement, lead: { comments: Comment[]; blanks: number }): Statement {
        while (this.peek().type === ";") {
            this.consume();
        }
        const held = this.pullHeld();
        const trailing = this.detachTrailing();
        stmt.commentsBefore = lead.comments;
        stmt.blankLinesBefore = lead.blanks;
        stmt.commentsAfter = [...held, ...trailing];
        return stmt;
    }

    private hoistLeading(): { comments: Comment[]; blanks: number } {
        const token = this.peek();
        const comments = this.takeAll(token.commentsBefore);
        let blanks = 0;
        if (comments.length > 0) {
            blanks = Math.min(comments[0].extraBlankLines, 1);
            comments[0].extraBlankLines = 0;
        } else {
            blanks = Math.min(token.blankLinesBefore, 1);
        }
        return { comments, blanks };
    }

    private brokeBefore(): boolean {
        const token = this.peek();
        return token.type !== "eof" && token.line > this.lastEndLine;
    }

    private beginNode(): Comment[] {
        return [...this.pullHeld(), ...this.takeAll(this.peek().commentsBefore)];
    }

    private consume(): Token {
        const token = this.tokens[this.pos++];
        if (token.commentsBefore.length > 0) {
            this.held.push(...this.takeAll(token.commentsBefore));
        }
        this.lastEndLine = token.endLine;
        return token;
    }

    private pullHeld(): Comment[] {
        const held = this.held;
        this.held = [];
        return held;
    }

    private detachTrailing(): Comment[] {
        const next = this.peek();
        const taken: Comment[] = [];
        while (next.commentsBefore.length > 0 && next.commentsBefore[0].line === this.lastEndLine) {
            const comment = next.commentsBefore.shift();
            if (comment) {
                taken.push(comment);
            }
        }
        return taken;
    }

    private takeAll(list: Comment[]): Comment[] {
        return list.splice(0, list.length);
    }

    private expect(type: string): Token {
        const token = this.peek();
        if (token.type !== type) {
            this.fail(token, `expected '${type}'`);
        }
        return this.consume();
    }

    private expectKeyword(value: string): Token {
        const token = this.peek();
        if (token.type !== "keyword" || token.value !== value) {
            this.fail(token, `expected '${value}'`);
        }
        return this.consume();
    }

    private expectIdent(): Token {
        const token = this.peek();
        if (token.type !== "ident") {
            this.fail(token, "expected a name");
        }
        return this.consume();
    }

    private consumeIf(type: string): boolean {
        if (this.peek().type === type) {
            this.consume();
            return true;
        }
        return false;
    }

    private isBlockEnd(): boolean {
        const token = this.peek();
        if (token.type === "eof") {
            return true;
        }
        return token.type === "keyword" && (token.value === "end" || token.value === "else" || token.value === "elseif" || token.value === "until");
    }

    private isContinueStatement(): boolean {
        const token = this.peek();
        if (!(token.type === "ident" && token.value === "continue")) {
            return false;
        }
        const next = this.peek(1);
        if (
            next.type === "(" || next.type === "{" || next.type === "string" || next.type === "longString" ||
            next.type === "backtick" || next.type === "interp" || next.type === "." || next.type === ":" ||
            next.type === "[" || next.type === "=" || next.type === "," || next.type === "<"
        ) {
            return false;
        }
        return !COMPOUND.has(next.type);
    }

    private looksLikeTypeAlias(typeIndex: number): boolean {
        const name = this.peek(typeIndex + 1);
        if (name.type !== "ident") {
            return false;
        }
        const after = this.peek(typeIndex + 2);
        return after.type === "=" || after.type === "<";
    }

    private looksLikeTypeFunction(typeIndex: number): boolean {
        const next = this.peek(typeIndex + 1);
        return next.type === "keyword" && next.value === "function";
    }

    private isExprStart(): boolean {
        const token = this.peek();
        if (
            token.type === "ident" || token.type === "number" || token.type === "string" || token.type === "longString" ||
            token.type === "backtick" || token.type === "interp" || token.type === "..." || token.type === "(" ||
            token.type === "{" || token.type === "-" || token.type === "#" || token.type === "~"
        ) {
            return true;
        }
        return token.type === "keyword" && (token.value === "nil" || token.value === "true" || token.value === "false" || token.value === "function" || token.value === "if" || token.value === "not");
    }

    private binaryOp(token: Token): string | null {
        if (token.type === "keyword" && (token.value === "and" || token.value === "or")) {
            return token.value;
        }
        if (Object.prototype.hasOwnProperty.call(PREC, token.type)) {
            return token.type;
        }
        return null;
    }

    private unaryOp(token: Token): string | null {
        if (token.type === "keyword" && token.value === "not") {
            return "not";
        }
        if (token.type === "-" || token.type === "#" || token.type === "~") {
            return token.type;
        }
        return null;
    }
}

function isLValue(expr: Expr): boolean {
    return expr.kind === "name" || expr.kind === "field" || expr.kind === "index";
}
