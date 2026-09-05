# r2 command cheatsheet (verified against radare2 6.x)

Load on demand. All commands run through `r2_cmd`; append `j` (or set
`json: true`) for JSON output of any listed command.

## Information

| Command | JSON | Purpose |
| --- | --- | --- |
| `iI` | `iIj` | File/architecture summary (class, bits, OS, compiler) |
| `i` | `ij` | All bin info |
| `iS` | `iSj` | Sections |
| `im` | `imj` | Memory/symbol ranges (main, entry) |
| `is` | `isj` | Symbols |
| `ii` | `iij` | Imports |
| `iE` | `iEj` | Exports (entry points) |
| `iz` | `izj` | Strings in data sections |
| `izz` | `izzj` | Strings in the whole binary (slow on large files) |
| `iV` | `iVj` | Version info |

## Analysis

| Command | Purpose |
| --- | --- |
| `aa` | Basic analysis (symbols + entry0) |
| `aaa` | Standard analysis (**default after r2_open**) |
| `aaaa` | Experimental (loops/emulation) — much slower |
| `af @ <addr>` | Analyze function at address |
| `afl` | List functions |
| `axt @ <fcn>` | Xrefs to (who calls it) |
| `axf @ <fcn>` | Xrefs from (what it calls) |
| `aar` | Discover references |

Gotchas:
- `pdf`/`axt` return little before analysis — run `aaa` (or `r2_analyze`) first.
- Never send `aaj`/`aaaj` (JSON variants of analysis commands hang in some builds).
- The `/` search family (`/`, `/r`, `/c`) can be very slow on large binaries;
  scope with `@ <section>` when possible.

## Disassembly & decompilation

| Command | Purpose |
| --- | --- |
| `pdf @ <fcn>` | Disassemble function |
| `pd N @ <addr>` | Disassemble N instructions at address |
| `pdr @ <fcn>` | Recursive disassembly |
| `pdg @ <fcn>` | r2ghidra decompiler (if installed) |
| `pdd @ <fcn>` | r2dec decompiler (if installed) |
| `pdc @ <fcn>` | Built-in pseudo-C decompiler (always available) |

## Flags, seek, print

| Command | Purpose |
| --- | --- |
| `f~<name>` | Find flag matching name |
| `s <addr>` / `s <fcn>` | Seek (session-wide cursor) |
| `px 64 @ <addr>` | Hexdump 64 bytes |
| `ps @ <addr>` | Print string at address |
| `apg` | Generate R2 CMD graph / `agf` function graph |

## Patching (allowed; writes confined to the sandbox allowlist)

| Command | Purpose |
| --- | --- |
| `wx 9090 @ <addr>` | Write hex bytes |
| `wa nop` | Assemble and write instruction |
| `wtf` | Write from file/string |
| `ws <string>` | Write string |
| `Ps <name>` | Save r2 project (`.r2`) |

## Remote (only when `allowRemote` is enabled)

| URI | Purpose |
| --- | --- |
| `rap://host:port/cmd` | radare2 remote protocol |
| `tcp://host:port` | TCP transport |
