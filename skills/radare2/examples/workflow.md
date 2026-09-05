# Worked example: recon of an unknown binary

A typical session using the `r2_*` tools. The agent sees output like this.

## 1. Open + auto-analysis

**Call:** `r2_open { "path": "/usr/bin/ls" }`

**Result (condensed):**
```
location: /usr/bin/ls
analysis: aaa (auto)
functions: 136 (e.g. entry0, sym.imp.__assert_rtn, main)

Use this handle in r2_* tools: r2-1 (sandbox: seatbelt)
```

## 2. Triage

**Call:** `r2_functions { "handle": "r2-1", "filter": "parse", "limit": 20 }`

**Result:**
```
functions: 4
parse_long_option (size 812)  int parse_long_option(...)
...
```

**Call:** `r2_xrefs { "handle": "r2-1", "target": "main", "direction": "from" }`

**Result:**
```
xrefs (from main): 14
CALL  4294984336 -> 4294983904
...
```

## 3. Deep-dive

**Call:** `r2_disassemble { "handle": "r2-1", "target": "parse_long_option" }`

**Result:** the function's `pdf` listing (instructions, args, xref comments).

For pseudo-C instead of assembly:

**Call:** `r2_cmd { "handle": "r2-1", "command": "pdc @ parse_long_option" }`

## 4. Strings

**Call:** `r2_strings { "handle": "r2-1", "minLength": 8, "limit": 50 }`

**Result:**
```
strings: 50 (of 412)
4294976120  --all
4294976128  --almost-all
...
```

## 5. Raw escape hatch

**Call:** `r2_cmd { "handle": "r2-1", "command": "afl~sym.imp", "json": false }`

Grep-style `~` filters work inside a single command; anything needing
multiple steps is separate `r2_cmd` calls (no newlines).

## 6. Close

**Call:** `r2_close { "handle": "r2-1" }`
