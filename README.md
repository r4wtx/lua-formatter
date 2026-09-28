# Lua Formatter 2026

Formats Lua and Luau. It covers standard Lua, labels, attributes, types, generics, and backtick literals. Names are left as written, so any library API stays intact.

Semicolons are optional in Lua. This formatter writes them by default. That keeps a line break from gluing two statements together, which Lua will do for a call that starts with `(`, a string, or `{`.

```lua
local function greet(name)
    print("hi " .. name);
end;

local message = `Hello {name}!`;
onReady("start", function(data)
    print(message, data);
end);
```

```lua
export type PlayerData = {
    name: string,
    coins: number,
};

local function grant(player: Player, amount: number): number
    local data: PlayerData = {
        name = player.name,
        coins = amount,
    };
    return data.coins;
end;
```

## What it formats

- Lua 5.1 through 5.4: functions, tables, long strings, varargs, `goto`, bitwise operators, floor division, `<const>` and `<close>`
- Luau: types, generics, `continue`, compound assignment, if-expressions, `::` assertions, string interpolation, `type` and `type function`
- Backtick literals such as `` `item_name` ``. A backtick string that contains `{...}` is treated as an interpolation and the expression inside is formatted

If a file is not valid Lua, it is left unchanged and the syntax error is reported in the Problems panel.

## Commands

- **Format Document** (`Shift+Alt+F`)
- **Lua Formatter: Format Document**

Open a `.lua` or `.luau` file, then run **Format Document**.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `luaFormatter.semicolons` | `true` | End statements with `;` |
| `luaFormatter.indentSize` | editor tab size | Spaces per indent |
| `luaFormatter.useTabs` | editor `insertSpaces` | Indent with tabs |
| `luaFormatter.lineWidth` | `100` | Unused. Line breaks already in the file are kept |
| `luaFormatter.quoteStyle` | `preserve` | `preserve`, `single`, or `double` |
| `luaFormatter.trailingComma` | `multiline` | Trailing commas in tables only |
| `luaFormatter.insertFinalNewline` | `true` | Newline at end of file |

## License

MIT.
