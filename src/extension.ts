import * as vscode from "vscode";
import { FormatError, FormatOptions, QuoteStyle, TrailingComma, formatLua } from "./formatter/format";

const SELECTOR: vscode.DocumentSelector = [
    { language: "lua" },
    { language: "luau" },
];

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection("lua-formatter-2026");
    const provider: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
        provideDocumentFormattingEdits(document) {
            return formatDocument(document, diagnostics);
        },
        provideDocumentRangeFormattingEdits(document) {
            return formatDocument(document, diagnostics);
        },
    };

    context.subscriptions.push(
        diagnostics,
        vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, provider),
        vscode.languages.registerDocumentRangeFormattingEditProvider(SELECTOR, provider),
        vscode.commands.registerCommand("lua-formatter-2026.format", async () => {
            await vscode.commands.executeCommand("editor.action.formatDocument");
        }),
    );
}

export function deactivate(): void {}

function formatDocument(document: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection): vscode.TextEdit[] {
    const source = document.getText();
    try {
        const formatted = formatLua(source, readOptions(document));
        diagnostics.delete(document.uri);
        if (formatted === source) {
            return [];
        }
        const full = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
        return [vscode.TextEdit.replace(full, formatted)];
    } catch (error) {
        const formatError = error instanceof FormatError ? error : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const line = Math.max(0, (formatError?.line ?? 1) - 1);
        const column = Math.max(0, (formatError?.column ?? 1) - 1);
        const clampedLine = Math.min(line, Math.max(0, document.lineCount - 1));
        const range = new vscode.Range(clampedLine, column, clampedLine, column);
        const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = "Lua Formatter";
        diagnostics.set(document.uri, [diagnostic]);
        return [];
    }
}

function readOptions(document: vscode.TextDocument): Partial<FormatOptions> {
    const config = vscode.workspace.getConfiguration("luaFormatter", document.uri);
    const editor = vscode.workspace.getConfiguration("editor", document.uri);
    const indentSize = explicit<number>(config, "indentSize") ?? editor.get<number>("tabSize", 4);
    const useTabs = explicit<boolean>(config, "useTabs") ?? editor.get<boolean>("insertSpaces", true) === false;
    return {
        indentSize,
        useTabs,
        semicolons: config.get<boolean>("semicolons", true),
        lineWidth: config.get<number>("lineWidth", 100),
        quoteStyle: config.get<QuoteStyle>("quoteStyle", "preserve"),
        trailingComma: config.get<TrailingComma>("trailingComma", "multiline"),
        insertFinalNewline: config.get<boolean>("insertFinalNewline", true),
        eol: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
    };
}

function explicit<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
    const info = config.inspect<T>(key);
    if (!info) {
        return undefined;
    }
    if (info.workspaceFolderValue !== undefined) {
        return info.workspaceFolderValue;
    }
    if (info.workspaceValue !== undefined) {
        return info.workspaceValue;
    }
    if (info.globalValue !== undefined) {
        return info.globalValue;
    }
    return undefined;
}
