import {
    Arguments,
    Block,
    Chunk,
    Comment,
    Expr,
    GenericParam,
    LocalName,
    Punctuated,
    Statement,
    TableField,
    TypeField,
    TypeFuncParam,
    TypeNode,
} from "./ast";
import { FormatOptions } from "./options";

type FuncExpr = Extract<Expr, { kind: "function" }>;

export function printChunk(chunk: Chunk, options: FormatOptions): string {
    return new Printer(options).print(chunk);
}

class Printer {
    private out = "";
    private col = 0;
    private lineStart = true;
    private needNewline = false;
    private pendingSpace = false;
    private indent = 0;

    constructor(private readonly options: FormatOptions) {}

    print(chunk: Chunk): string {
        if (chunk.shebang) {
            this.appendRaw(chunk.shebang);
            this.newline();
        }
        for (const stmt of chunk.block.statements) {
            this.printStatement(stmt);
        }
        if (chunk.block.openComments.length > 0) {
            this.printOwnLineComments(chunk.block.openComments);
        }
        if (chunk.block.closeComments.length > 0) {
            this.printOwnLineComments(chunk.block.closeComments);
        }
        if (chunk.eofComments.length > 0) {
            this.printOwnLineComments(chunk.eofComments);
        }
        let text = this.out;
        if (text.length === 0) {
            return "";
        }
        if (this.options.insertFinalNewline && !text.endsWith(this.options.eol)) {
            text += this.options.eol;
        }
        return text;
    }

    private printStatement(stmt: Statement): void {
        if (stmt.kind === "empty" && stmt.commentsBefore.length === 0 && stmt.commentsAfter.length === 0 && stmt.attributes.length === 0) {
            return;
        }
        if (this.out.length > 0 && (!this.lineStart || this.needNewline)) {
            this.newline();
        }
        if (this.out.length > 0 && stmt.blankLinesBefore > 0) {
            this.newline();
        }
        if (stmt.commentsBefore.length > 0) {
            this.printOwnLineComments(stmt.commentsBefore);
            this.ensureBreak();
        }
        for (const attribute of stmt.attributes) {
            this.ensureBreak();
            this.write("@" + attribute);
            this.needNewline = true;
        }
        if (stmt.kind !== "empty") {
            this.ensureBreak();
            this.printStatementBody(stmt);
            if (this.options.semicolons) {
                this.write(";");
            }
        }
        if (stmt.commentsAfter.length > 0) {
            if (!this.lineStart && !this.out.endsWith(" ")) {
                this.write(" ");
            }
            for (const comment of stmt.commentsAfter) {
                this.appendRaw(comment.text);
                if (comment.kind === "line") {
                    this.needNewline = true;
                }
            }
        }
    }

    private printStatementBody(stmt: Statement): void {
        switch (stmt.kind) {
            case "empty":
                return;
            case "break":
                this.write("break");
                return;
            case "continue":
                this.write("continue");
                return;
            case "goto":
                this.write("goto " + stmt.name);
                return;
            case "label":
                this.write("::" + stmt.name + "::");
                return;
            case "do":
                this.write("do");
                this.newline();
                this.printBlock(stmt.body);
                this.ensureBreak();
                this.write("end");
                return;
            case "while":
                this.write("while ");
                this.printExpr(stmt.cond);
                this.write(" do");
                this.newline();
                this.printBlock(stmt.body);
                this.ensureBreak();
                this.write("end");
                return;
            case "repeat":
                this.write("repeat");
                this.newline();
                this.printBlock(stmt.body);
                this.ensureBreak();
                this.write("until ");
                this.printExpr(stmt.cond);
                return;
            case "if":
                this.printIf(stmt);
                return;
            case "numericFor":
                this.write("for " + stmt.name);
                if (stmt.annotation) {
                    this.write(": ");
                    this.printType(stmt.annotation);
                }
                this.write(" = ");
                this.printExpr(stmt.start);
                this.write(", ");
                this.printExpr(stmt.stop);
                if (stmt.step) {
                    this.write(", ");
                    this.printExpr(stmt.step);
                }
                this.write(" do");
                this.newline();
                this.printBlock(stmt.body);
                this.ensureBreak();
                this.write("end");
                return;
            case "genericFor":
                this.write("for ");
                this.printLocalNames(stmt.names);
                this.write(" in ");
                this.printPunctuated(stmt.iters, this.sourceBroken(stmt.iters));
                this.write(" do");
                this.newline();
                this.printBlock(stmt.body);
                this.ensureBreak();
                this.write("end");
                return;
            case "local":
                this.printLocal(stmt);
                return;
            case "localFunction":
                this.printFunctionValue("local function " + stmt.name, stmt.func);
                return;
            case "function":
                this.printFunctionValue("function " + stmt.path.join(".") + (stmt.method ? ":" + stmt.method : ""), stmt.func);
                return;
            case "assign":
                this.printAssign(stmt.targets, stmt.values);
                return;
            case "compound":
                this.printExpr(stmt.target);
                if (stmt.valueBreak) {
                    this.write(" " + stmt.op);
                    this.newline();
                    this.indent++;
                    this.printExpr(stmt.value);
                    this.indent--;
                } else {
                    this.write(" " + stmt.op + " ");
                    this.printExpr(stmt.value);
                }
                return;
            case "call":
                this.printExpr(stmt.expr);
                return;
            case "return":
                this.write("return");
                if (stmt.values.length > 0) {
                    if (this.sourceBroken(stmt.values)) {
                        this.newline();
                        this.indent++;
                        this.printPunctuated(stmt.values, true);
                        this.indent--;
                    } else {
                        this.write(" ");
                        this.printPunctuated(stmt.values, false);
                    }
                }
                return;
            case "typeAlias":
                this.printTypeAlias(stmt);
                return;
            case "typeFunction": {
                const header = (stmt.exported ? "export type function " : "type function ") + stmt.name;
                this.printFunctionValue(header, stmt.func);
                return;
            }
            default:
                return assertNever(stmt);
        }
    }

    private printIf(stmt: Extract<Statement, { kind: "if" }>): void {
        this.write("if ");
        this.printExpr(stmt.clauses[0].cond);
        this.write(" then");
        this.newline();
        this.printBlock(stmt.clauses[0].body);
        for (const clause of stmt.clauses.slice(1)) {
            this.ensureBreak();
            this.write("elseif ");
            this.printExpr(clause.cond);
            this.write(" then");
            this.newline();
            this.printBlock(clause.body);
        }
        if (stmt.elseBody) {
            this.ensureBreak();
            this.write("else");
            this.newline();
            this.printBlock(stmt.elseBody);
        }
        this.ensureBreak();
        this.write("end");
    }

    private printLocal(stmt: Extract<Statement, { kind: "local" }>): void {
        const broken = this.sourceBroken(stmt.values);
        if (!broken && this.tryHangValue(() => {
            this.write("local ");
            this.printLocalNames(stmt.names);
            this.write(" = ");
        }, stmt.values)) {
            return;
        }
        this.write("local ");
        this.printLocalNames(stmt.names);
        if (stmt.values.length === 0) {
            return;
        }
        if (broken) {
            this.write(" =");
            this.newline();
            this.indent++;
            this.printPunctuated(stmt.values, true);
            this.indent--;
            return;
        }
        this.write(" = ");
        this.printPunctuated(stmt.values, false);
    }

    private printAssign(targets: Punctuated<Expr>[], values: Punctuated<Expr>[]): void {
        const broken = this.sourceBroken(values);
        if (!broken && this.tryHangValue(() => {
            this.printPunctuated(targets, this.sourceBroken(targets));
            this.write(" = ");
        }, values)) {
            return;
        }
        this.printPunctuated(targets, this.sourceBroken(targets));
        if (broken) {
            this.write(" =");
            this.newline();
            this.indent++;
            this.printPunctuated(values, true);
            this.indent--;
            return;
        }
        this.write(" = ");
        this.printPunctuated(values, false);
    }

    private tryHangValue(prefix: () => void, values: Punctuated<Expr>[]): boolean {
        if (values.length !== 1 || values[0].breakBefore) {
            return false;
        }
        const value = values[0].node;
        if (value.kind !== "function" && value.kind !== "table" && value.kind !== "longString" && value.kind !== "backtick" && value.kind !== "interp") {
            return false;
        }
        prefix();
        this.printExpr(value);
        this.printTrailing(values[0].trailing);
        return true;
    }

    private printTypeAlias(stmt: Extract<Statement, { kind: "typeAlias" }>): void {
        const header = () => {
            if (stmt.exported) {
                this.write("export ");
            }
            this.write("type " + stmt.name);
            if (stmt.generics && stmt.generics.length > 0) {
                this.printGenerics(stmt.generics);
            }
        };
        header();
        if (stmt.valueBreak) {
            this.write(" =");
            this.newline();
            this.indent++;
            this.printType(stmt.value);
            this.indent--;
            return;
        }
        this.write(" = ");
        this.printType(stmt.value);
    }

    private printFunctionValue(header: string, fn: FuncExpr): void {
        const signature = (broken: boolean) => {
            this.write(header);
            if (fn.generics && fn.generics.length > 0) {
                this.printGenerics(fn.generics);
            }
            this.write("(");
            if (broken && (fn.params.length > 0 || fn.vararg)) {
                this.newline();
                this.indent++;
                this.printParams(fn, true);
                this.indent--;
                this.ensureBreak();
            } else {
                this.printParams(fn, false);
            }
            this.write(")");
            if (fn.returnType) {
                this.write(": ");
                this.printType(fn.returnType);
            }
        };
        signature(fn.paramsBroken);
        this.newline();
        this.printBlock(fn.body);
        this.ensureBreak();
        this.write("end");
    }

    private printParams(fn: FuncExpr, broken: boolean): void {
        fn.params.forEach((param, index) => {
            if (index > 0) {
                this.write(",");
                if (broken) {
                    this.newline();
                } else {
                    this.write(" ");
                }
            }
            this.write(param.name);
            if (param.annotation) {
                this.write(": ");
                this.printType(param.annotation);
            }
        });
        if (fn.vararg) {
            if (fn.params.length > 0) {
                this.write(",");
                if (broken) {
                    this.newline();
                } else {
                    this.write(" ");
                }
            }
            this.write("...");
            if (fn.varargType) {
                this.write(": ");
                this.printType(fn.varargType);
            }
        }
    }

    private printBlock(block: Block): void {
        this.indent++;
        if (block.openComments.length > 0) {
            this.printOwnLineComments(block.openComments);
        }
        for (const stmt of block.statements) {
            this.printStatement(stmt);
        }
        if (block.closeBlankLines > 0 && (block.statements.length > 0 || block.openComments.length > 0)) {
            this.ensureBreak();
            this.newline();
        }
        if (block.closeComments.length > 0) {
            this.printOwnLineComments(block.closeComments);
        }
        this.indent--;
    }

    private printLocalNames(names: LocalName[]): void {
        names.forEach((name, index) => {
            if (index > 0) {
                this.write(", ");
            }
            this.write(name.name);
            if (name.annotation) {
                this.write(": ");
                this.printType(name.annotation);
            }
            if (name.attribute) {
                this.write(" <" + name.attribute + ">");
            }
        });
    }

    private printPunctuated(items: Punctuated<Expr>[], broken: boolean): void {
        items.forEach((item, index) => {
            if (broken && index > 0) {
                this.ensureBreak();
            }
            this.printExpr(item.node);
            if (index < items.length - 1) {
                this.write(",");
            }
            this.printTrailing(item.trailing);
            if (!broken && index < items.length - 1) {
                this.write(" ");
            }
        });
    }

    private printExpr(expr: Expr): void {
        this.printCommentsInline(expr.commentsBefore);
        if (this.needNewline) {
            this.newline();
        }
        if (this.pendingSpace && !this.lineStart) {
            this.write(" ");
            this.pendingSpace = false;
        }
        switch (expr.kind) {
            case "nil":
            case "true":
            case "false":
                this.write(expr.kind);
                return;
            case "vararg":
                this.write("...");
                return;
            case "number":
                this.write(expr.raw);
                return;
            case "string":
                this.write(this.requote(expr.raw));
                return;
            case "longString":
            case "backtick":
                this.appendRaw(expr.raw);
                return;
            case "interp":
                this.appendRaw("`");
                for (const part of expr.parts) {
                    if (part.kind === "text") {
                        this.appendRaw(part.text);
                    } else {
                        this.appendRaw("{");
                        this.printExpr(part.expr);
                        this.appendRaw("}");
                    }
                }
                this.appendRaw("`");
                return;
            case "name":
                this.write(expr.name);
                return;
            case "paren":
                this.write("(");
                this.printExpr(expr.expr);
                this.write(")");
                return;
            case "unary":
                if (expr.op === "not") {
                    this.write("not");
                    this.write(" ");
                } else {
                    this.write(expr.op);
                    if (expr.arg.kind === "unary") {
                        this.write(" ");
                    }
                }
                this.printExpr(expr.arg);
                return;
            case "binary":
                this.printBinary(expr);
                return;
            case "field":
                this.printExpr(expr.object);
                this.write("." + expr.name);
                return;
            case "index":
                this.printExpr(expr.object);
                this.write("[");
                this.printExpr(expr.index);
                this.write("]");
                return;
            case "call":
                this.printInvocation(() => this.printExpr(expr.callee), expr.args, expr.typeArgs);
                return;
            case "method":
                this.printInvocation(() => {
                    this.printExpr(expr.object);
                    this.write(":" + expr.method);
                }, expr.args, expr.typeArgs);
                return;
            case "function":
                this.printFunctionValue("function", expr);
                return;
            case "table":
                this.printTable(expr);
                return;
            case "if":
                this.printIfExpr(expr);
                return;
            case "assertion":
                this.printExpr(expr.expr);
                this.write(" :: ");
                this.printType(expr.annotation);
                return;
            default:
                return assertNever(expr);
        }
    }

    private printBinary(expr: Extract<Expr, { kind: "binary" }>): void {
        this.printExpr(expr.left);
        this.printCommentsInline(expr.opComments);
        if (expr.breakBefore) {
            this.ensureBreak();
            this.indent++;
            this.write(expr.op);
            if (expr.breakAfter) {
                this.newline();
            } else {
                this.write(" ");
            }
            this.printExpr(expr.right);
            this.indent--;
            return;
        }
        if (this.needNewline) {
            this.newline();
        }
        if (expr.breakAfter) {
            if (this.lineStart) {
                this.write(expr.op);
            } else {
                this.write(" " + expr.op);
            }
            this.newline();
            this.indent++;
            this.printExpr(expr.right);
            this.indent--;
            return;
        }
        if (this.lineStart) {
            this.write(expr.op + " ");
        } else {
            this.write(" " + expr.op + " ");
        }
        this.printExpr(expr.right);
    }

    private printIfExpr(expr: Extract<Expr, { kind: "if" }>): void {
        if (!expr.multiline) {
            expr.clauses.forEach((clause, index) => {
                this.write(index === 0 ? "if " : " elseif ");
                this.printExpr(clause.cond);
                this.write(" then ");
                this.printExpr(clause.body);
            });
            this.write(" else ");
            this.printExpr(expr.elseExpr);
            return;
        }
        expr.clauses.forEach((clause, index) => {
            if (index > 0) {
                this.ensureBreak();
            }
            this.write(index === 0 ? "if " : "elseif ");
            this.printExpr(clause.cond);
            this.write(" then");
            this.newline();
            this.indent++;
            this.printExpr(clause.body);
            this.indent--;
        });
        this.ensureBreak();
        this.write("else");
        this.newline();
        this.indent++;
        this.printExpr(expr.elseExpr);
        this.indent--;
    }

    private printInvocation(prefix: () => void, args: Arguments, typeArgs?: TypeNode[]): void {
        prefix();
        if (typeArgs && typeArgs.length > 0) {
            this.printTypeArgs(typeArgs);
        }
        const broken = args.kind === "paren" && this.sourceBroken(args.items);
        this.printArguments(args, broken);
    }

    private printArguments(args: Arguments, broken: boolean): void {
        if (args.kind === "string") {
            this.write(" ");
            this.printExpr(args.expr);
            return;
        }
        if (args.kind === "table") {
            this.write(" ");
            this.printExpr(args.table);
            return;
        }
        this.write("(");
        if (args.items.length === 0 && args.closeComments.length === 0) {
            this.write(")");
            return;
        }
        if (!broken) {
            this.printPunctuated(args.items, false);
            if (args.closeComments.length > 0) {
                this.printCommentsInline(args.closeComments);
            }
            this.write(")");
            return;
        }
        if (args.items.length > 0) {
            this.newline();
            this.indent++;
            this.printPunctuated(args.items, true);
            if (args.closeComments.length > 0) {
                this.printOwnLineComments(args.closeComments);
            }
            this.indent--;
            this.ensureBreak();
        } else if (args.closeComments.length > 0) {
            this.newline();
            this.indent++;
            this.printOwnLineComments(args.closeComments);
            this.indent--;
            this.ensureBreak();
        }
        this.write(")");
    }

    private printTable(expr: Extract<Expr, { kind: "table" }>): void {
        if (expr.fields.length === 0 && expr.closeComments.length === 0) {
            this.write("{}");
            return;
        }
        if (!expr.multiline) {
            this.write("{ ");
            this.printFields(expr.fields, false);
            if (expr.closeComments.length > 0) {
                this.printCommentsInline(expr.closeComments);
            }
            this.write(" }");
            return;
        }
        this.write("{");
        this.newline();
        this.indent++;
        this.printFields(expr.fields, true);
        if (expr.closeComments.length > 0) {
            this.printOwnLineComments(expr.closeComments);
        }
        this.indent--;
        this.ensureBreak();
        this.write("}");
    }

    private printFields(fields: TableField[], broken: boolean): void {
        fields.forEach((field, index) => {
            if (broken && index > 0) {
                this.ensureBreak();
            }
            if (field.leading.length > 0) {
                this.printOwnLineComments(field.leading);
                this.ensureBreak();
            }
            this.printFieldValue(field);
            const last = index === fields.length - 1;
            if (!last || this.wantTrailingComma(broken)) {
                this.write(",");
            }
            this.printTrailing(field.trailing);
            if (!broken && !last) {
                this.write(" ");
            }
        });
    }

    private printFieldValue(field: TableField): void {
        if (field.kind === "name") {
            this.write(field.name + " = ");
            this.printExpr(field.value);
            return;
        }
        if (field.kind === "index") {
            this.write("[");
            this.printExpr(field.key);
            this.write("] = ");
            this.printExpr(field.value);
            return;
        }
        this.printExpr(field.value);
    }

    private printType(type: TypeNode): void {
        switch (type.kind) {
            case "nil":
            case "true":
            case "false":
                this.write(type.kind);
                return;
            case "string":
                this.write(this.requote(type.raw));
                return;
            case "name":
                this.write(type.parts.join("."));
                if (type.typeArgs && type.typeArgs.length > 0) {
                    this.printTypeArgs(type.typeArgs);
                }
                if (type.pack) {
                    this.write("...");
                }
                return;
            case "optional":
                this.printType(type.base);
                this.write("?");
                return;
            case "union":
                this.printTypeList(type.options, " | ", "| ", type.breakBefore.some(Boolean));
                return;
            case "intersection":
                this.printTypeList(type.parts, " & ", "& ", type.breakBefore.some(Boolean));
                return;
            case "negation":
                this.write("~");
                this.printType(type.base);
                return;
            case "typeof":
                this.write("typeof(");
                this.printExpr(type.expr);
                this.write(")");
                return;
            case "variadic":
                this.write("...");
                if (type.base) {
                    this.printType(type.base);
                }
                return;
            case "paren":
                this.write("(");
                this.printType(type.base);
                this.write(")");
                return;
            case "tuple":
                this.write("(");
                type.types.forEach((item, index) => {
                    if (index > 0) {
                        this.write(", ");
                    }
                    this.printType(item);
                });
                this.write(")");
                return;
            case "function":
                if (type.generics && type.generics.length > 0) {
                    this.printGenerics(type.generics);
                }
                this.write("(");
                this.printTypeParams(type.params);
                this.write(") -> ");
                this.printType(type.returnType);
                return;
            case "table":
                this.printTypeTable(type.fields, type.multiline);
                return;
            default:
                return assertNever(type);
        }
    }

    private printTypeList(types: TypeNode[], flatSep: string, brokenOp: string, broken: boolean): void {
        if (!broken) {
            types.forEach((type, index) => {
                if (index > 0) {
                    this.write(flatSep);
                }
                this.printType(type);
            });
            return;
        }
        this.printType(types[0]);
        for (const type of types.slice(1)) {
            this.newline();
            this.indent++;
            this.write(brokenOp);
            this.printType(type);
            this.indent--;
        }
    }

    private printTypeTable(fields: TypeField[], multiline: boolean): void {
        if (fields.length === 0) {
            this.write("{}");
            return;
        }
        if (!multiline) {
            this.write("{ ");
            fields.forEach((field, index) => {
                if (index > 0) {
                    this.write(", ");
                }
                this.printTypeField(field);
            });
            this.write(" }");
            return;
        }
        this.write("{");
        this.newline();
        this.indent++;
        fields.forEach((field, index) => {
            if (index > 0) {
                this.ensureBreak();
            }
            this.printTypeField(field);
            if (index < fields.length - 1 || this.wantTrailingComma(true)) {
                this.write(",");
            }
        });
        this.indent--;
        this.ensureBreak();
        this.write("}");
    }

    private printTypeField(field: TypeField): void {
        if (field.kind === "array") {
            this.printType(field.type);
            return;
        }
        if (field.modifier) {
            this.write(field.modifier + " ");
        }
        if (field.kind === "prop") {
            this.write(field.name + ": ");
            this.printType(field.type);
            return;
        }
        this.write("[");
        this.printType(field.key);
        this.write("]: ");
        this.printType(field.type);
    }

    private printTypeParams(params: TypeFuncParam[]): void {
        params.forEach((param, index) => {
            if (index > 0) {
                this.write(", ");
            }
            if (param.name) {
                this.write(param.name + ": ");
            }
            this.printType(param.type);
        });
    }

    private printGenerics(params: GenericParam[]): void {
        this.write("<");
        params.forEach((param, index) => {
            if (index > 0) {
                this.write(", ");
            }
            this.write(param.name);
            if (param.pack) {
                this.write("...");
            }
            if (param.defaultType) {
                this.write(" = ");
                this.printType(param.defaultType);
            }
        });
        this.write(">");
    }

    private printTypeArgs(args: TypeNode[]): void {
        this.write("<");
        args.forEach((arg, index) => {
            if (index > 0) {
                this.write(", ");
            }
            this.printType(arg);
        });
        this.write(">");
    }

    private sourceBroken(items: { breakBefore: boolean }[]): boolean {
        return items.some((item) => item.breakBefore);
    }

    private wantTrailingComma(broken: boolean): boolean {
        if (this.options.trailingComma === "never") {
            return false;
        }
        if (this.options.trailingComma === "always") {
            return true;
        }
        return broken;
    }

    private printTrailing(comments: Comment[]): void {
        if (comments.length === 0) {
            return;
        }
        if (!this.lineStart && !this.out.endsWith(" ")) {
            this.write(" ");
        }
        for (const comment of comments) {
            this.appendRaw(comment.text);
            if (comment.kind === "line") {
                this.needNewline = true;
            }
        }
    }

    private printOwnLineComments(comments: Comment[]): void {
        comments.forEach((comment, index) => {
            if (index > 0 || !this.lineStart || this.needNewline) {
                this.ensureBreak();
            }
            if (index > 0 && comment.extraBlankLines > 0) {
                this.newline();
            }
            this.writeComment(comment);
            if (comment.kind === "line") {
                this.needNewline = true;
            }
        });
    }

    private printCommentsInline(comments: Comment[]): void {
        for (const comment of comments) {
            if (comment.newlineBefore || this.needNewline) {
                this.ensureBreak();
                for (let i = 0; i < Math.min(comment.extraBlankLines, 1); i++) {
                    this.newline();
                }
            } else if (!this.lineStart && !this.out.endsWith(" ")) {
                this.write(" ");
            }
            this.appendRaw(comment.text);
            if (comment.kind === "line") {
                this.needNewline = true;
            } else {
                this.pendingSpace = true;
            }
        }
    }

    private writeComment(comment: Comment): void {
        if (comment.kind === "block" && (comment.text.includes("\n") || comment.text.includes("\r"))) {
            if (this.needNewline) {
                this.newline();
            }
            if (this.lineStart) {
                this.out += this.currentIndent();
                this.col = this.indentCols();
                this.lineStart = false;
            }
            this.appendRaw(comment.text);
            return;
        }
        this.write(comment.text);
    }

    private requote(raw: string): string {
        if (this.options.quoteStyle === "preserve") {
            return raw;
        }
        const quote = raw[0];
        if ((quote !== "'" && quote !== "\"") || raw.length < 2 || raw[raw.length - 1] !== quote) {
            return raw;
        }
        const target = this.options.quoteStyle === "single" ? "'" : "\"";
        if (quote === target) {
            return raw;
        }
        const body = raw.slice(1, -1);
        if (body.includes("\\") || body.includes("\n") || body.includes("\r") || body.includes(target)) {
            return raw;
        }
        return target + body + target;
    }

    private ensureBreak(): void {
        if (this.needNewline || !this.lineStart) {
            this.newline();
        }
    }

    private write(text: string): void {
        if (text.length === 0) {
            return;
        }
        if (this.needNewline) {
            this.newline();
        }
        if (this.lineStart) {
            const indent = this.currentIndent();
            this.out += indent;
            this.col = this.indentCols();
            this.lineStart = false;
        }
        this.out += text;
        this.col += text.length;
    }

    private appendRaw(text: string): void {
        if (text.length === 0) {
            return;
        }
        if (this.lineStart && this.indent > 0 && !text.startsWith("\n") && !text.startsWith("\r")) {
            this.out += this.currentIndent();
            this.col = this.indentCols();
            this.lineStart = false;
        }
        this.out += text;
        const lastNl = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
        if (lastNl === -1) {
            this.col += text.length;
            this.lineStart = false;
        } else {
            this.col = text.length - lastNl - 1;
            this.lineStart = this.col === 0;
        }
    }

    private newline(): void {
        this.out += this.options.eol;
        this.col = 0;
        this.lineStart = true;
        this.needNewline = false;
        this.pendingSpace = false;
    }

    private currentIndent(): string {
        if (this.options.useTabs) {
            return "\t".repeat(this.indent);
        }
        return " ".repeat(this.indent * this.options.indentSize);
    }

    private indentCols(): number {
        return this.indent * this.options.indentSize;
    }
}

function assertNever(value: never): never {
    throw new Error("unhandled formatter node: " + JSON.stringify(value));
}
