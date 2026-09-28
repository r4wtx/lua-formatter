# Lua Formatter

<p align="center">
  <img src="https://rawtx.gallerycdn.vsassets.io/extensions/rawtx/lua-formatter-2026/0.1.4/1790574803044/Microsoft.VisualStudio.Services.Icons.Default" width="128">
</p>

a simple formatter for Lua and Luau.

supports things like:

* Lua 5.1, 5.4
* Luau types and generics
* Labels and `goto`
* Compound assignment
* String interpolation
* Backtick strings
* Tables and functions

it keeps names and library APIs as they are

### example

```lua
local function greet(name)
    print("hi " .. name);
end;

local message = `Hello {name}!`;

greet("world");
```

### Commands

* **Format Document** - `shift + alt + f` (literally default vscode format)
* **Lua Formatter: Format Document**

open a `.lua` or `.luau` file and format the document!

### Settings

| Setting                           | Default        |
| --------------------------------- | -------------- |
| `luaFormatter.semicolons`         | `true`         |
| `luaFormatter.indentSize`         | editor setting |
| `luaFormatter.useTabs`            | editor setting |
| `luaFormatter.lineWidth`          | `100`          |
| `luaFormatter.quoteStyle`         | `preserve`     |
| `luaFormatter.trailingComma`      | `multiline`    |
| `luaFormatter.insertFinalNewline` | `true`         |

## License

MIT. check out: [LICENSE](LICENSE).
