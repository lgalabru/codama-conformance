# Codama renderer conformance vectors

A shared, language-agnostic test-vector corpus for the four self-contained
Codama renderers — `renderers-python`, `renderers-ruby`, `renderers-php` and
`renderers-lua`. Each of those packages emits a generated Solana client that
ships its own Borsh runtime, base58/Pubkey, sha256, PDA derivation (with the
ed25519 on-curve check) and account/instruction/type/error codegen. This
corpus pins the byte-exact expectations once so the four e2e smoke tests stop
duplicating hardcoded values.

The pinned JSON files in `vectors/` are **the source of truth**. They were
generated from reference implementations (`@solana/web3.js` for PDA/curve,
`node:crypto` for sha256, `@solana/kit` codecs for Borsh) and cross-checked
against the constants hardcoded in the existing renderer smoke tests. Do not
edit them by hand and do not regenerate them casually — regenerate only when
*adding* vectors, and diff the result to confirm existing vectors did not
change.

## Files

| File | Mode | Contents |
| --- | --- | --- |
| `vectors/borsh-primitives.json` | `borsh` | Encode/decode round-trips for u8…u128, i8…i128, f32/f64, bool, option (incl. nested), u32-prefixed strings, fixed/prefixed bytes, shortU16, vec, fixed arrays, map, set, tuple — plus truncation/overrun error cases. |
| `vectors/base58.json` | `base58` | Encode/decode pairs (known program ids, leading zeros, generic blobs) and invalid-character / wrong-length errors. |
| `vectors/sha256.json` | `sha256` | NIST vectors ("", "abc", the 448-bit two-block message, 10^6 × "a"), padding/block boundaries and binary inputs. |
| `vectors/pda.json` | `pda` | `findProgramAddress` / `createProgramAddress` vectors (incl. bumps 249–253 that reject several on-curve candidates), seed-validation errors and explicit on-curve / off-curve / invalid-encoding classification. |
| `vectors/instructions.json` | `instruction` | Byte-exact instruction data + account-meta lists for the shared fixture IDLs (`e2e/{system,memo,pump-fun,dummy}/idl.json`). |
| `vectors/accounts.json` | `account` | Byte-exact serialized account states (system `Nonce` 80-byte layout, pump-fun `BondingCurve` 82-byte and `FeeConfig`) plus decode-error cases. |

## Vector schema

Every file is a JSON array of vector objects:

```jsonc
{
  "id": "borsh-u64-max",            // globally unique, stable
  "mode": "borsh",                  // borsh | base58 | sha256 | pda | instruction | account
  "description": "...",             // human-readable; cites the smoke test it was lifted from
  "input": { ... },                 // mode-specific, see below
  "expected": { ... },              // mode-specific oracle
  "optional": true                  // OPTIONAL: implementation-defined; runners may skip
}
```

### Portability conventions

JSON types are kept language-portable:

- **Byte blobs** are lowercase hex strings (`"dataHex"`, `"hex"`, seeds, …).
- **u64 / u128 / i64 / i128 values** are decimal *strings* (`"18446744073709551615"`),
  never JSON numbers — JSON numbers are only used where they are exact
  (≤ 32-bit integers, exactly-representable floats).
- **Pubkeys** are base58 strings.
- **Floats** in vectors are always exactly representable in the target width
  (1.5, -2.25, 2^-10, …) so no float-to-text round-tripping issues arise.
- **Option values**: `null` is none, `{"some": <value>}` is some — this nests
  (`{"some": {"some": 5}}`, `{"some": null}`).
- **Maps** are arrays of `[key, value]` pairs, **sets** are arrays of items —
  both always listed in canonical ascending key/item order (see below).
- **Scalar enums** (e.g. `NonceState`) are their numeric variant index.

### Error convention

A vector whose `expected` is `{ "error": true }` must make the runtime raise
its typed error (e.g. `SerializationError` / `Borsh::Error` /
`SerializationException` / a `codama.borsh:` Lua error) — a crash or a wrong
value is a failure. Error vectors cover truncated reads, length-prefix
overruns, bad option flags, over-long shortU16 encodings, invalid base58,
wrong-length pubkeys, on-curve PDA rejection and seed validation.

### `optional: true`

Marks behavior that is implementation-defined across the four runtimes. A
runner either skips the vector or asserts it knowingly. Current cases:

- `borsh-option-bad-flag` — python rejects option flags other than 0/1;
  ruby/php/lua treat any non-zero flag as some.
- `borsh-option-nested-some-none` — runtimes using null/nil as the none
  sentinel cannot construct `some(none)`.
- `borsh-shortu16-alias-accepted` — aliased (non-canonical) encodings decode
  fine in all four runtimes today, but re-encode canonically; pinned
  decode-only.
- `borsh-{map,set}-unordered-input-canonicalized` — sorting writers (python,
  lua) canonicalize out-of-order input; insertion-order writers (ruby, php)
  do not.
- `ix-pump-buy-default-program-accounts` — requires constant-pubkey default
  resolution in the instruction builder.
- `account-system-nonce-unknown-enum-variant` — strict enum decoders reject
  unknown variant indexes; runtimes that surface scalar enums as raw integers
  accept them.

Unsupported features are skips, not failures: e.g. the python runtime has no
shortU16 codec, so a python runner skips `type: "shortu16"` vectors and
reports them as skipped.

## Modes

### `borsh`

```jsonc
"input": {
  "type": <type-descriptor>,
  "value": <portable value>,        // present for encode/round-trip vectors
  "hex": "…",                       // present for decode-only vectors
  "direction": "encode" | "decode"  // omitted = round-trip (both)
}
"expected": { "hex": "…" } | { "value": … } | { "error": true }
```

Round-trip (default): `encode(type, value) == expected.hex` **and**
`decode(type, expected.hex) == value`. `direction: "encode"` checks only the
first, `direction: "decode"` decodes `input.hex` and compares against
`expected.value` (or expects an error).

Type descriptors form a small language the runner interprets against its
generated Borsh runtime:

```
"u8" "u16" "u32" "u64" "u128" "i8" "i16" "i32" "i64" "i128"
"f32" "f64" "bool" "shortu16"
"string"               u32-prefixed UTF-8
"bytes"                u32-prefixed byte blob (value is hex)
"pubkey"               32 raw bytes (value is base58)
{"option": T}
{"fixedBytes": n}      value is hex
{"vec": T}             u32 count prefix
{"array": {"item": T, "size": n}}
{"map": {"key": K, "value": V}}    u32 count prefix
{"set": T}                          u32 count prefix
{"tuple": [T, ...]}
```

**Deterministic map/set ordering rule** (mirrors the renderers' runtimes):
serialized map entries and set items appear in ascending key/item order —
natural ordering for integers and strings, encoded-byte order otherwise.
Python and lua writers sort on encode; ruby and php writers preserve
insertion order. Corpus inputs are therefore always pre-sorted so all four
produce identical bytes; the `*-unordered-input-canonicalized` vectors pin
the sorting behavior alone and are `optional`.

### `base58`

```jsonc
"input": { "base58": "…", "as": "bytes" | "pubkey" }
"expected": { "hex": "…" } | { "error": true }
```

Bidirectional: `decode(base58) == hex` and `encode(hex) == base58`.
`as: "pubkey"` routes through the runtime's Pubkey type (which enforces the
32-byte length); `as: "bytes"` is the generic codec — runtimes that do not
expose generic base58 skip those.

### `sha256`

```jsonc
"input": { "utf8": "…" } | { "hex": "…" } | { "repeat": { "utf8": "a", "count": 1000000 } }
"expected": { "hex": "<64-char digest>" }
```

`repeat` keeps long NIST inputs out of the JSON; the runner materializes
`utf8 × count` before hashing.

### `pda`

```jsonc
"input": {
  "op": "findProgramAddress" | "createProgramAddress" | "isOnCurve",
  "seeds": ["<hex>", …],            // find/create; pubkey seeds are their 32-byte hex
  "programId": "<base58>",          // find/create
  "bytes": "<32-byte hex>"          // isOnCurve
}
"expected":
  { "address": "<base58>", "bump": 250 }   // findProgramAddress
| { "address": "<base58>" }                // createProgramAddress
| { "onCurve": true|false }                // isOnCurve
| { "error": true }                        // on-curve rejection / seed validation
```

### `instruction`

```jsonc
"input": {
  "program": "system" | "memo" | "pump" | "dummy",   // fixture IDL key
  "instruction": "transferSol" | …,                  // camelCase IDL name
  "accounts": { "<name>": "<base58>", … },           // explicitly supplied accounts
  "args": { "<name>": <portable value>, … },
  "dataHex": "…", "direction": "decode"              // decode-only error vectors
}
"expected": {
  "programId": "<base58>",
  "dataHex": "…",
  "accounts": [ { "name": "…", "isSigner": bool, "isWritable": bool, "address": "<base58>"? }, … ]
}
```

Runners dispatch on `(program, instruction)` to their generated builder,
build the instruction, and assert the data bytes, program id and account-meta
list (order, flags, and `address` where pinned). `expected.accounts` is
omitted when the metas are not deterministic (memo remaining accounts);
`address` is omitted when the account is caller-supplied but not part of the
vector's input (pump `create`). Decode vectors feed `dataHex` to the
instruction-data deserializer and expect a typed error.

The fixture IDLs are the identical `e2e/{system,memo,pump-fun,dummy}/idl.json`
files shipped in each renderer package.

### `account`

```jsonc
"input": {
  "program": "system" | "pump",
  "account": "nonce" | "bondingCurve" | "feeConfig",
  "fields": { … },                       // portable field values, camelCase IDL names
  "hex": "…", "direction": "decode"      // decode-only error vectors
}
"expected": { "hex": "…", "size": 80 } | { "error": true }
```

Round-trip: `serialize(fields) == expected.hex`, `len == expected.size` (when
present), and `deserialize(expected.hex)` equals the constructed value.

## Runner contract

Each language gets one conformance runner (one per renderer package, living
next to its e2e tests) that:

1. loads every `vectors/*.json` in this directory,
2. dispatches on each vector's `mode` (and the mode-specific sub-keys above),
3. asserts the `expected` oracle, treating `{ "error": true }` as
   "a typed error must be raised",
4. skips `optional` vectors it cannot honor and vectors using features the
   runtime does not ship (and counts them as skipped, not failed),
5. exits non-zero on any failure and prints `passed / failed / skipped`
   counts per mode.

## Regenerating

```sh
cd conformance
npm install          # @solana/web3.js + @solana/kit (node_modules is gitignored)
node generate-vectors.mjs
```

The script is deterministic and idempotent — running it twice produces
byte-identical files. It embeds sanity checks that compare its output against
the constants hardcoded in the four renderer smoke tests
(`renderers-python/e2e/smoke_test.py`, `renderers-ruby/e2e/*/main.rb`,
`renderers-php/e2e/smoke.php`, `renderers-lua/e2e/*/smoke_test.lua`) and
aborts on any mismatch, so a regeneration can never silently drift from the
behavior the smoke tests already pinned.

Again: pinned files are the source of truth. Regenerate only to add vectors;
never to "fix" a failing runner — if a runner disagrees with a pinned vector,
the runner (or the renderer runtime) is wrong until proven otherwise.
