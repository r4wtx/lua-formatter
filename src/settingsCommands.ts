import * as vscode from "vscode";

const section = "luaFormatter";

interface SettingChoice<T> extends vscode.QuickPickItem {
    value: T;
}

export function readStoredSetting<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
    const info = config.inspect<T>(key);
    if (!info) {
        return undefined;
    }
    const levels = info as typeof info & {
        workspaceFolderLanguageValue?: T;
        workspaceLanguageValue?: T;
        globalLanguageValue?: T;
    };
    if (levels.workspaceFolderLanguageValue !== undefined) {
        return levels.workspaceFolderLanguageValue;
    }
    if (levels.workspaceLanguageValue !== undefined) {
        return levels.workspaceLanguageValue;
    }
    if (levels.globalLanguageValue !== undefined) {
        return levels.globalLanguageValue;
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

export function registerSettingsCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("lua-formatter-2026.configure", configure),
        vscode.commands.registerCommand("lua-formatter-2026.openSettings", openSettings),
        vscode.commands.registerCommand("lua-formatter-2026.semicolons", chooseSemicolons),
        vscode.commands.registerCommand("lua-formatter-2026.quoteStyle", chooseQuoteStyle),
        vscode.commands.registerCommand("lua-formatter-2026.trailingComma", chooseTrailingComma),
        vscode.commands.registerCommand("lua-formatter-2026.insertFinalNewline", chooseFinalNewline),
        vscode.commands.registerCommand("lua-formatter-2026.indentSize", chooseIndentSize),
        vscode.commands.registerCommand("lua-formatter-2026.useTabs", chooseUseTabs),
    );
}

async function configure(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
        [
            { label: "Semicolons", description: shown("semicolons"), run: chooseSemicolons },
            { label: "Quote Style", description: shown("quoteStyle"), run: chooseQuoteStyle },
            { label: "Trailing Commas", description: shown("trailingComma"), run: chooseTrailingComma },
            { label: "Final Newline", description: shown("insertFinalNewline"), run: chooseFinalNewline },
            { label: "Indent Size", description: shownIndent(), run: chooseIndentSize },
            { label: "Use Tabs", description: shownTabs(), run: chooseUseTabs },
        ],
        { title: "Lua Formatter", placeHolder: "Choose a setting" },
    );
    if (picked) {
        await picked.run();
    }
}

async function openSettings(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.openSettings", "luaFormatter");
}

async function chooseSemicolons(): Promise<void> {
    await choose("semicolons", "Semicolons", [
        { label: "true", description: "Write a semicolon after each statement", value: true },
        { label: "false", description: "Do not add semicolons", value: false },
    ]);
}

async function chooseQuoteStyle(): Promise<void> {
    await choose("quoteStyle", "Quote Style", [
        { label: "preserve", description: "Leave quotes as they were written", value: "preserve" },
        { label: "single", description: "Use single quotes when it is safe", value: "single" },
        { label: "double", description: "Use double quotes when it is safe", value: "double" },
    ]);
}

async function chooseTrailingComma(): Promise<void> {
    await choose("trailingComma", "Trailing Commas", [
        { label: "multiline", description: "Only when a table spans more than one line", value: "multiline" },
        { label: "always", description: "After every table field", value: "always" },
        { label: "never", description: "Do not add trailing commas", value: "never" },
    ]);
}

async function chooseFinalNewline(): Promise<void> {
    await choose("insertFinalNewline", "Final Newline", [
        { label: "true", description: "End the file with a newline", value: true },
        { label: "false", description: "Do not add a final newline", value: false },
    ]);
}

async function chooseUseTabs(): Promise<void> {
    await choose("useTabs", "Use Tabs", [
        { label: "true", description: "Indent with tabs", value: true },
        { label: "false", description: "Indent with spaces", value: false },
        { label: "editor", description: "Follow the editor insertSpaces setting", value: undefined },
    ]);
}

async function chooseIndentSize(): Promise<void> {
    const current = stored("indentSize");
    const picked = await vscode.window.showQuickPick<SettingChoice<number | "other" | "editor">>([
        sizeChoice(2, current),
        sizeChoice(4, current),
        sizeChoice(8, current),
        { label: "Other number...", value: "other" },
        {
            label: "editor",
            description: current === undefined ? "current" : "Follow the editor tab size",
            value: "editor",
        },
    ], { title: "Lua Formatter: Indent Size", placeHolder: "Choose a value" });
    if (!picked) {
        return;
    }
    if (picked.value === "editor") {
        await save("indentSize", undefined, "Indent size follows the editor tab size.");
        return;
    }
    if (picked.value === "other") {
        const typed = await vscode.window.showInputBox({
            title: "Lua Formatter: Indent Size",
            prompt: "Spaces per indent level",
            value: typeof current === "number" ? String(current) : "4",
            validateInput(text) {
                const size = Number(text);
                if (!Number.isInteger(size) || size < 1) {
                    return "Enter a whole number, 1 or higher.";
                }
                return undefined;
            },
        });
        if (typed === undefined) {
            return;
        }
        await save("indentSize", Number(typed), `Indent size set to ${typed}.`);
        return;
    }
    await save("indentSize", picked.value, `Indent size set to ${picked.value}.`);
}

async function choose<T>(key: string, title: string, choices: SettingChoice<T>[]): Promise<void> {
    const current = stored(key);
    const picked = await vscode.window.showQuickPick(choices.map((choice) => ({
        ...choice,
        description: choice.value === current ? "current" : choice.description,
    })), {
        title: `Lua Formatter: ${title}`,
        placeHolder: "Choose a value",
    });
    if (!picked) {
        return;
    }
    const message = picked.value === undefined
        ? `${title} follows the editor.`
        : `${title} set to ${picked.label}.`;
    await save(key, picked.value, message);
}

function sizeChoice(size: number, current: unknown): SettingChoice<number> {
    return {
        label: String(size),
        description: current === size ? "current" : undefined,
        value: size,
    };
}

function shown(key: string): string {
    const value = vscode.workspace.getConfiguration(section).get(key);
    return value === undefined ? "" : String(value);
}

function shownIndent(): string {
    const value = stored("indentSize");
    return typeof value === "number" ? String(value) : "editor";
}

function shownTabs(): string {
    const value = stored("useTabs");
    return typeof value === "boolean" ? String(value) : "editor";
}

function stored(key: string): unknown {
    return readStoredSetting(vscode.workspace.getConfiguration(section), key);
}

async function save(key: string, value: unknown, message: string): Promise<void> {
    try {
        await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(text);
        return;
    }
    void vscode.window.showInformationMessage(message);
}
