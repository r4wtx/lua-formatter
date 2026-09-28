export interface Comment {
    kind: "line" | "block";
    text: string;
    line: number;
    newlineBefore: boolean;
    extraBlankLines: number;
}

export interface Comments {
    commentsBefore: Comment[];
    commentsAfter: Comment[];
}

export interface Block {
    statements: Statement[];
    openComments: Comment[];
    closeComments: Comment[];
    closeBlankLines: number;
}

export interface GenericParam {
    name: string;
    pack: boolean;
    defaultType?: TypeNode;
}

export interface Param {
    name: string;
    annotation?: TypeNode;
}

export interface LocalName {
    name: string;
    annotation?: TypeNode;
    attribute?: string;
}

export type TypeNode =
    | { kind: "nil" }
    | { kind: "true" }
    | { kind: "false" }
    | { kind: "string"; raw: string }
    | { kind: "name"; parts: string[]; typeArgs?: TypeNode[]; pack: boolean }
    | { kind: "optional"; base: TypeNode }
    | { kind: "negation"; base: TypeNode }
    | { kind: "typeof"; expr: Expr }
    | { kind: "variadic"; base?: TypeNode }
    | { kind: "paren"; base: TypeNode }
    | { kind: "tuple"; types: TypeNode[] }
    | { kind: "function"; generics?: GenericParam[]; params: TypeFuncParam[]; returnType: TypeNode }
    | { kind: "table"; fields: TypeField[]; multiline: boolean }
    | { kind: "union"; options: TypeNode[]; breakBefore: boolean[] }
    | { kind: "intersection"; parts: TypeNode[]; breakBefore: boolean[] };

export interface TypeFuncParam {
    name?: string;
    type: TypeNode;
}

export type TypeField =
    | { kind: "prop"; name: string; modifier?: "read" | "write"; type: TypeNode }
    | { kind: "indexer"; key: TypeNode; modifier?: "read" | "write"; type: TypeNode }
    | { kind: "array"; type: TypeNode };

export interface Punctuated<T> {
    node: T;
    trailing: Comment[];
    breakBefore: boolean;
}

export type Expr =
    | ({ kind: "nil" | "true" | "false" | "vararg" } & Comments)
    | ({ kind: "number"; raw: string } & Comments)
    | ({ kind: "string"; raw: string } & Comments)
    | ({ kind: "longString"; raw: string } & Comments)
    | ({ kind: "backtick"; raw: string } & Comments)
    | ({ kind: "interp"; parts: InterpPart[] } & Comments)
    | ({ kind: "name"; name: string } & Comments)
    | ({ kind: "paren"; expr: Expr } & Comments)
    | ({ kind: "unary"; op: string; arg: Expr } & Comments)
    | ({ kind: "binary"; op: string; left: Expr; right: Expr; opComments: Comment[]; breakBefore: boolean; breakAfter: boolean } & Comments)
    | ({ kind: "field"; object: Expr; name: string } & Comments)
    | ({ kind: "index"; object: Expr; index: Expr } & Comments)
    | ({ kind: "call"; callee: Expr; args: Arguments; typeArgs?: TypeNode[] } & Comments)
    | ({ kind: "method"; object: Expr; method: string; args: Arguments; typeArgs?: TypeNode[] } & Comments)
    | ({ kind: "function"; generics?: GenericParam[]; params: Param[]; vararg: boolean; varargType?: TypeNode; returnType?: TypeNode; body: Block; paramsBroken: boolean } & Comments)
    | ({ kind: "table"; fields: TableField[]; closeComments: Comment[]; multiline: boolean } & Comments)
    | ({ kind: "if"; clauses: IfExprClause[]; elseExpr: Expr; multiline: boolean } & Comments)
    | ({ kind: "assertion"; expr: Expr; annotation: TypeNode } & Comments);

export type InterpPart =
    | { kind: "text"; text: string }
    | { kind: "expr"; expr: Expr };

export interface IfExprClause {
    cond: Expr;
    body: Expr;
}

export type TableField =
    | { kind: "name"; name: string; value: Expr; trailing: Comment[]; leading: Comment[] }
    | { kind: "index"; key: Expr; value: Expr; trailing: Comment[]; leading: Comment[] }
    | { kind: "expr"; value: Expr; trailing: Comment[]; leading: Comment[] };

export type Arguments =
    | { kind: "paren"; items: Punctuated<Expr>[]; closeComments: Comment[] }
    | { kind: "table"; table: Expr }
    | { kind: "string"; expr: Expr };

interface StmtBase extends Comments {
    blankLinesBefore: number;
    attributes: string[];
}

export type Statement =
    | (StmtBase & { kind: "empty" })
    | (StmtBase & { kind: "break" })
    | (StmtBase & { kind: "continue" })
    | (StmtBase & { kind: "goto"; name: string })
    | (StmtBase & { kind: "label"; name: string })
    | (StmtBase & { kind: "do"; body: Block })
    | (StmtBase & { kind: "while"; cond: Expr; body: Block })
    | (StmtBase & { kind: "repeat"; body: Block; cond: Expr })
    | (StmtBase & { kind: "if"; clauses: IfClause[]; elseBody?: Block })
    | (StmtBase & { kind: "numericFor"; name: string; annotation?: TypeNode; start: Expr; stop: Expr; step?: Expr; body: Block })
    | (StmtBase & { kind: "genericFor"; names: LocalName[]; iters: Punctuated<Expr>[]; body: Block })
    | (StmtBase & { kind: "local"; names: LocalName[]; values: Punctuated<Expr>[] })
    | (StmtBase & { kind: "localFunction"; name: string; func: Extract<Expr, { kind: "function" }> })
    | (StmtBase & { kind: "function"; path: string[]; method?: string; func: Extract<Expr, { kind: "function" }> })
    | (StmtBase & { kind: "assign"; targets: Punctuated<Expr>[]; values: Punctuated<Expr>[] })
    | (StmtBase & { kind: "compound"; target: Expr; op: string; value: Expr; valueBreak: boolean })
    | (StmtBase & { kind: "call"; expr: Expr })
    | (StmtBase & { kind: "return"; values: Punctuated<Expr>[] })
    | (StmtBase & { kind: "typeAlias"; exported: boolean; name: string; generics?: GenericParam[]; value: TypeNode; valueBreak: boolean })
    | (StmtBase & { kind: "typeFunction"; exported: boolean; name: string; func: Extract<Expr, { kind: "function" }> });

export interface IfClause {
    cond: Expr;
    body: Block;
}

export interface Chunk {
    shebang?: string;
    block: Block;
    eofComments: Comment[];
}

export function emptyComments(): Comments {
    return { commentsBefore: [], commentsAfter: [] };
}
