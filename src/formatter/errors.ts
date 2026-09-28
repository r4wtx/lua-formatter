export class FormatError extends Error {
    readonly line: number;
    readonly column: number;

    constructor(message: string, line: number, column: number) {
        super(`${message} at line ${line}, column ${column}`);
        this.name = "FormatError";
        this.line = line;
        this.column = column;
    }
}
