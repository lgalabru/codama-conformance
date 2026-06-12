#!/usr/bin/env node
/**
 * Regenerates the pinned conformance vectors in `vectors/*.json` using
 * reference implementations:
 *
 *   - PDA derivation / on-curve checks: @solana/web3.js
 *     (PublicKey.createProgramAddressSync / findProgramAddressSync / isOnCurve)
 *   - sha256: node:crypto
 *   - Borsh primitives: @solana/kit codecs (getU64Codec, getOptionCodec,
 *     getShortU16Codec, ...). Nothing is hand-rolled except trivial
 *     concatenation of codec outputs for instruction/account layouts.
 *
 * The script is deterministic (no randomness, no clock, no network) and
 * idempotent: running it twice produces byte-identical files.
 *
 * It also sanity-checks a sample of the generated values against constants
 * hardcoded in the four renderer e2e smoke tests
 * (renderers-{python,ruby,php,lua}/e2e/...). A mismatch aborts generation.
 *
 * Usage: node generate-vectors.mjs
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';
import {
    addCodecSizePrefix,
    fixCodecSize,
    getArrayCodec,
    getBase58Codec,
    getBooleanCodec,
    getBytesCodec,
    getF32Codec,
    getF64Codec,
    getI8Codec,
    getI16Codec,
    getI32Codec,
    getI64Codec,
    getI128Codec,
    getMapCodec,
    getOptionCodec,
    getSetCodec,
    getShortU16Codec,
    getTupleCodec,
    getU8Codec,
    getU16Codec,
    getU32Codec,
    getU64Codec,
    getU128Codec,
    getUtf8Codec,
    none,
    some,
} from '@solana/kit';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vectors');

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b58 = getBase58Codec();
const b58decode = (s) => new Uint8Array(b58.encode(s)); // string -> bytes
const b58encode = (bytes) => b58.decode(bytes); // bytes -> string

function assertEq(actual, expected, label) {
    const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
    const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`sanity check failed (${label}):\n  actual:   ${a}\n  expected: ${e}`);
    }
}

// ---------------------------------------------------------------------------
// Borsh type-descriptor interpreter over @solana/kit codecs.
//
// Type descriptors (the same mini-language the per-language runners
// interpret, see README.md):
//   "u8".."u128", "i8".."i128", "f32", "f64", "bool", "shortu16",
//   "string" (u32-prefixed utf8), "bytes" (u32-prefixed), "pubkey",
//   {"option": T}, {"fixedBytes": n}, {"vec": T},
//   {"array": {"item": T, "size": n}}, {"map": {"key": K, "value": V}},
//   {"set": T}, {"tuple": [T, ...]}
// ---------------------------------------------------------------------------

function codecFor(type) {
    if (typeof type === 'string') {
        switch (type) {
            case 'u8': return getU8Codec();
            case 'u16': return getU16Codec();
            case 'u32': return getU32Codec();
            case 'u64': return getU64Codec();
            case 'u128': return getU128Codec();
            case 'i8': return getI8Codec();
            case 'i16': return getI16Codec();
            case 'i32': return getI32Codec();
            case 'i64': return getI64Codec();
            case 'i128': return getI128Codec();
            case 'f32': return getF32Codec();
            case 'f64': return getF64Codec();
            case 'bool': return getBooleanCodec();
            case 'shortu16': return getShortU16Codec();
            case 'string': return addCodecSizePrefix(getUtf8Codec(), getU32Codec());
            case 'bytes': return addCodecSizePrefix(getBytesCodec(), getU32Codec());
            case 'pubkey': return fixCodecSize(getBytesCodec(), 32);
            default: throw new Error(`unknown scalar type: ${type}`);
        }
    }
    if (type.option) return getOptionCodec(codecFor(type.option));
    if (type.fixedBytes !== undefined) return fixCodecSize(getBytesCodec(), type.fixedBytes);
    if (type.vec) return getArrayCodec(codecFor(type.vec), { size: getU32Codec() });
    if (type.array) return getArrayCodec(codecFor(type.array.item), { size: type.array.size });
    if (type.map) {
        return getMapCodec(codecFor(type.map.key), codecFor(type.map.value), { size: getU32Codec() });
    }
    if (type.set) return getSetCodec(codecFor(type.set), { size: getU32Codec() });
    if (type.tuple) return getTupleCodec(type.tuple.map(codecFor));
    throw new Error(`unknown type descriptor: ${JSON.stringify(type)}`);
}

/** Converts a JSON vector value (portable conventions) to a JS value for kit codecs. */
function jsValue(type, v) {
    if (typeof type === 'string') {
        switch (type) {
            case 'u64': case 'u128': case 'i64': case 'i128':
                return BigInt(v);
            case 'bytes':
                return fromHex(v);
            case 'pubkey':
                return b58decode(v);
            default:
                return v;
        }
    }
    if (type.option) return v === null ? none() : some(jsValue(type.option, v.some));
    if (type.fixedBytes !== undefined) return fromHex(v);
    if (type.vec) return v.map((item) => jsValue(type.vec, item));
    if (type.array) return v.map((item) => jsValue(type.array.item, item));
    if (type.map) {
        return new Map(v.map(([k, val]) => [jsValue(type.map.key, k), jsValue(type.map.value, val)]));
    }
    if (type.set) return new Set(v.map((item) => jsValue(type.set, item)));
    if (type.tuple) return v.map((item, i) => jsValue(type.tuple[i], item));
    throw new Error(`unknown type descriptor: ${JSON.stringify(type)}`);
}

/** Encodes a (type, JSON value) pair to hex with the reference codecs. */
function encodeHex(type, value) {
    return toHex(codecFor(type).encode(jsValue(type, value)));
}

// ---------------------------------------------------------------------------
// Vector constructors. The schema is documented in README.md:
//   { id, mode, description, input, expected } (+ optional: true for
//   implementation-defined cases that runners may skip).
// ---------------------------------------------------------------------------

/** Round-trip borsh vector: encode(value)==hex AND decode(hex)==value. */
function borsh(id, description, type, value) {
    return {
        id: `borsh-${id}`,
        mode: 'borsh',
        description,
        input: { type, value },
        expected: { hex: encodeHex(type, value) },
    };
}

/** Decode-only borsh vector (e.g. error cases, aliased encodings). */
function borshDecode(id, description, type, hex, expected, extra = {}) {
    return {
        id: `borsh-${id}`,
        mode: 'borsh',
        description,
        input: { type, hex, direction: 'decode' },
        expected,
        ...extra,
    };
}

/** Encode-only borsh vector. */
function borshEncode(id, description, type, value, expected, extra = {}) {
    return {
        id: `borsh-${id}`,
        mode: 'borsh',
        description,
        input: { type, value, direction: 'encode' },
        expected,
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// borsh-primitives.json
// ---------------------------------------------------------------------------

const borshVectors = [
    // --- unsigned integers -------------------------------------------------
    borsh('u8-zero', 'u8 minimum value.', 'u8', 0),
    borsh('u8-one', 'u8 value 1.', 'u8', 1),
    borsh('u8-max', 'u8 maximum value (255).', 'u8', 255),
    borshDecode('u8-truncated', 'Reading a u8 from an empty buffer must fail.', 'u8', '', { error: true }),
    borsh('u16-mixed-bytes', 'u16 0x1234: little-endian byte order is observable.', 'u16', 0x1234),
    borsh('u16-max', 'u16 maximum value (65535).', 'u16', 0xffff),
    borsh('u32-one', 'u32 value 1 (three trailing zero bytes).', 'u32', 1),
    borsh('u32-mixed-bytes', 'u32 0xdeadbeef: little-endian byte order.', 'u32', 0xdeadbeef),
    borsh('u32-max', 'u32 maximum value (4294967295).', 'u32', 0xffffffff),
    borsh('u64-zero', 'u64 zero. 64-bit values are decimal strings in JSON.', 'u64', '0'),
    borsh('u64-one-million', 'u64 1000000 (the transferSol smoke-test amount).', 'u64', '1000000'),
    borsh(
        'u64-2pow63',
        'u64 2^63: exceeds i64 range; must not be treated as a signed value.',
        'u64',
        '9223372036854775808',
    ),
    borsh('u64-max', 'u64 maximum value (2^64-1): all 0xff bytes.', 'u64', '18446744073709551615'),
    borshDecode(
        'u64-truncated',
        'Reading a u64 from a 3-byte buffer must fail (lua smoke-test case).',
        'u64',
        '010203',
        { error: true },
    ),
    borsh('u128-small', 'u128 42: a small value still occupies 16 bytes.', 'u128', '42'),
    borsh(
        'u128-2pow127',
        'u128 2^127 (python smoke-test case): 15 zero bytes then 0x80.',
        'u128',
        '170141183460469231731687303715884105728',
    ),
    borsh('u128-max', 'u128 maximum value (2^128-1): 16 0xff bytes.', 'u128', '340282366920938463463374607431768211455'),
    // --- signed integers ---------------------------------------------------
    borsh('i8-minus-one', "i8 -1: two's complement 0xff.", 'i8', -1),
    borsh('i8-min', 'i8 minimum value (-128).', 'i8', -128),
    borsh('i8-max', 'i8 maximum value (127).', 'i8', 127),
    borsh('i16-minus-two', 'i16 -2.', 'i16', -2),
    borsh('i16-min', 'i16 minimum value (-32768).', 'i16', -32768),
    borsh('i32-minus-one', 'i32 -1: four 0xff bytes (ruby kitchen-sink fixed-array element).', 'i32', -1),
    borsh('i32-min', 'i32 minimum value (-2147483648).', 'i32', -2147483648),
    borsh('i32-max', 'i32 maximum value (2147483647).', 'i32', 2147483647),
    borsh('i64-minus-one', 'i64 -1: eight 0xff bytes (php smoke-test case).', 'i64', '-1'),
    borsh('i64-minus-5000', 'i64 -5000 (php smoke-test case).', 'i64', '-5000'),
    borsh('i64-min', 'i64 minimum value (-2^63).', 'i64', '-9223372036854775808'),
    borsh('i64-max', 'i64 maximum value (2^63-1).', 'i64', '9223372036854775807'),
    borsh('i128-minus-one', 'i128 -1: sixteen 0xff bytes (python smoke-test case).', 'i128', '-1'),
    borsh(
        'i128-min',
        'i128 minimum value (-2^127, php smoke-test case).',
        'i128',
        '-170141183460469231731687303715884105728',
    ),
    borsh('i128-max', 'i128 maximum value (2^127-1).', 'i128', '170141183460469231731687303715884105727'),
    // --- floats (exactly-representable values only) ------------------------
    borsh('f32-zero', 'f32 positive zero.', 'f32', 0),
    borsh('f32-1p5', 'f32 1.5 (exactly representable).', 'f32', 1.5),
    borsh('f32-neg-2p25', 'f32 -2.25 (exactly representable).', 'f32', -2.25),
    borsh('f64-1p5', 'f64 1.5 (php smoke-test case).', 'f64', 1.5),
    borsh('f64-neg-1024p5', 'f64 -1024.5 (exactly representable).', 'f64', -1024.5),
    borsh('f64-2pow-10', 'f64 2^-10 = 0.0009765625 (exactly representable).', 'f64', 0.0009765625),
    // --- bool ---------------------------------------------------------------
    borsh('bool-true', 'bool true encodes as 0x01.', 'bool', true),
    borsh('bool-false', 'bool false encodes as 0x00.', 'bool', false),
    // --- option -------------------------------------------------------------
    borsh('option-u64-none', 'option<u64> none: a single 0x00 flag byte.', { option: 'u64' }, null),
    borsh('option-u64-some-7', 'option<u64> some(7): 0x01 flag + u64 LE payload.', { option: 'u64' }, { some: '7' }),
    borsh('option-u64-some-42', 'option<u64> some(42) (python smoke-test reader case).', { option: 'u64' }, { some: '42' }),
    borsh('option-u8-some-7', 'option<u8> some(7) (php smoke-test case).', { option: 'u8' }, { some: 7 }),
    borsh(
        'option-bool-some-false',
        'option<bool> some(false) must encode as 0x01 0x00, NOT as none (lua regression guard).',
        { option: 'bool' },
        { some: false },
    ),
    borsh('option-nested-none', 'option<option<u8>> none: a single 0x00.', { option: { option: 'u8' } }, null),
    {
        ...borsh(
            'option-nested-some-none',
            'option<option<u8>> some(none): outer 0x01 flag + inner 0x00 flag. Runtimes that use ' +
                'null/nil as the none sentinel (e.g. python, ruby, lua) cannot construct some(none) ' +
                'and may skip this vector; decode-capable runtimes should still accept the bytes.',
            { option: { option: 'u8' } },
            { some: null },
        ),
        optional: true,
    },
    borsh(
        'option-nested-some-some',
        'option<option<u8>> some(some(5)): two 0x01 flags + payload.',
        { option: { option: 'u8' } },
        { some: { some: 5 } },
    ),
    borshDecode(
        'option-bad-flag',
        'Strict decoders reject option flags other than 0 and 1 (python raises). ' +
            'Lenient decoders (ruby/php/lua) treat any non-zero flag as some; they may skip this vector.',
        { option: 'u8' },
        '0207',
        { error: true },
        { optional: true },
    ),
    borshDecode(
        'option-some-truncated',
        'option<u64> with a 0x01 flag but a truncated payload must fail.',
        { option: 'u64' },
        '012a0000',
        { error: true },
    ),
    // --- strings (u32-prefixed utf8) ----------------------------------------
    borsh('string-empty', 'Empty string: a zero u32 length prefix and no payload.', 'string', ''),
    borsh('string-ascii-hi', 'ASCII string "hi" (python smoke-test case).', 'string', 'hi'),
    borsh('string-ascii-hello', 'ASCII string "hello" (php/ruby smoke-test seed value).', 'string', 'hello'),
    borsh(
        'string-multibyte',
        'Multibyte UTF-8 "héllo ✨" (ruby memo smoke-test case): the prefix counts BYTES, not characters.',
        'string',
        'héllo ✨',
    ),
    borshDecode(
        'string-length-overrun',
        'A string whose u32 length prefix (100) exceeds the remaining bytes must fail.',
        'string',
        '640000006869',
        { error: true },
    ),
    borshDecode('string-truncated-prefix', 'A 2-byte buffer cannot hold the u32 length prefix.', 'string', '0200', {
        error: true,
    }),
    // --- byte arrays ---------------------------------------------------------
    borsh('fixed-bytes-4', 'Fixed 4-byte array: encoded verbatim, no prefix.', { fixedBytes: 4 }, '01020304'),
    borsh(
        'fixed-bytes-32-zero',
        'Fixed 32-byte array of zeros (pubkey-shaped).',
        { fixedBytes: 32 },
        '00'.repeat(32),
    ),
    borshDecode(
        'fixed-bytes-truncated',
        'Reading 4 fixed bytes from a 2-byte buffer must fail.',
        { fixedBytes: 4 },
        '0102',
        { error: true },
    ),
    borsh('prefixed-bytes', 'u32-prefixed byte blob.', 'bytes', 'aabbcc'),
    borsh('prefixed-bytes-empty', 'Empty u32-prefixed byte blob: just the zero prefix.', 'bytes', ''),
    borsh(
        'pubkey',
        'A pubkey is its raw 32 bytes (input as base58, per the corpus conventions).',
        'pubkey',
        'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    ),
    // --- shortU16 (Solana compact-u16) ---------------------------------------
    borsh('shortu16-0', 'shortU16 boundary: 0 encodes as a single 0x00.', 'shortu16', 0),
    borsh('shortu16-1', 'shortU16 1.', 'shortu16', 1),
    borsh('shortu16-7f', 'shortU16 boundary: 0x7f is the largest single-byte value.', 'shortu16', 0x7f),
    borsh('shortu16-80', 'shortU16 boundary: 0x80 is the smallest two-byte value (php smoke-test case).', 'shortu16', 0x80),
    borsh('shortu16-3fff', 'shortU16 boundary: 0x3fff is the largest two-byte value.', 'shortu16', 0x3fff),
    borsh('shortu16-4000', 'shortU16 boundary: 0x4000 is the smallest three-byte value.', 'shortu16', 0x4000),
    borsh('shortu16-ffff', 'shortU16 boundary: 0xffff is the maximum value.', 'shortu16', 0xffff),
    borshDecode(
        'shortu16-alias-accepted',
        'Non-canonical (aliased) encoding of 0 as [0x80, 0x00]. The four renderer runtimes accept ' +
            'aliased encodings on decode (decode-only: re-encoding produces the canonical form).',
        'shortu16',
        '8000',
        { value: 0 },
        { optional: true },
    ),
    borshDecode(
        'shortu16-too-long',
        'A fourth continuation byte exceeds the 3-byte maximum and must fail.',
        'shortu16',
        '80808001',
        { error: true },
    ),
    borshDecode(
        'shortu16-truncated',
        'A continuation bit with no following byte must fail.',
        'shortu16',
        '8080',
        { error: true },
    ),
    // --- vec / fixed array ----------------------------------------------------
    borsh('vec-u16', 'vec<u16> [1,2,3]: u32 count prefix + items (php smoke-test case).', { vec: 'u16' }, [1, 2, 3]),
    borsh('vec-u8-empty', 'Empty vec<u8>: just the zero count prefix.', { vec: 'u8' }, []),
    borsh('vec-u64', 'vec<u64> with 64-bit decimal-string items.', { vec: 'u64' }, ['1', '18446744073709551615']),
    borshDecode(
        'vec-count-overrun',
        'A vec whose count prefix (3) exceeds the available items must fail.',
        { vec: 'u16' },
        '030000000100',
        { error: true },
    ),
    borsh(
        'array-i32-3',
        'Fixed [i32; 3] array (ruby kitchen-sink fixed_window case): no count prefix.',
        { array: { item: 'i32', size: 3 } },
        [-1, 0, 2147483647],
    ),
    borsh('array-u8-4', 'Fixed [u8; 4] array.', { array: { item: 'u8', size: 4 } }, [1, 2, 3, 4]),
    // --- map / set --------------------------------------------------------------
    // Deterministic-ordering rule (from the renderers' borsh runtimes): writers
    // that normalize (python, lua) sort entries in ascending key order; writers
    // that preserve insertion order (ruby, php) rely on the caller. Corpus map
    // and set inputs are therefore ALWAYS listed in canonical ascending key
    // order so all four implementations produce identical bytes.
    borsh(
        'map-u8-u8',
        'map<u8,u8> {1:10, 3:30}: u32 count + entries in ascending key order (python smoke-test case).',
        { map: { key: 'u8', value: 'u8' } },
        [[1, 10], [3, 30]],
    ),
    borsh(
        'map-string-u8',
        'map<string,u8> {"a":1, "b":2} (php smoke-test case): keys in ascending order.',
        { map: { key: 'string', value: 'u8' } },
        [['a', 1], ['b', 2]],
    ),
    borsh(
        'map-string-u16',
        'map<string,u16> with the kitchen-sink metadata keys, ascending ("level" < "name").',
        { map: { key: 'string', value: 'u16' } },
        [['level', 99], ['name', 1]],
    ),
    borshEncode(
        'map-unordered-input-canonicalized',
        'Sorting writers (python, lua) canonicalize out-of-order map input to ascending key order. ' +
            'Insertion-order writers (ruby, php) may skip this vector.',
        { map: { key: 'u8', value: 'u8' } },
        [[3, 30], [1, 10]],
        { hex: encodeHex({ map: { key: 'u8', value: 'u8' } }, [[1, 10], [3, 30]]) },
        { optional: true },
    ),
    borshDecode(
        'map-truncated',
        'A map whose count prefix (2) exceeds the available entries must fail.',
        { map: { key: 'u8', value: 'u8' } },
        '02000000010a',
        { error: true },
    ),
    borsh(
        'set-string',
        'set<string> {"a","b"}: u32 count + items in ascending order (python smoke-test case).',
        { set: 'string' },
        ['a', 'b'],
    ),
    borsh('set-u8', 'set<u8> {1,2,255} in ascending order.', { set: 'u8' }, [1, 2, 255]),
    borshEncode(
        'set-unordered-input-canonicalized',
        'Sorting writers (python, lua) canonicalize out-of-order set input. ' +
            'Insertion-order writers (ruby, php) may skip this vector.',
        { set: 'string' },
        ['b', 'a'],
        { hex: encodeHex({ set: 'string' }, ['a', 'b']) },
        { optional: true },
    ),
    // --- tuple -------------------------------------------------------------------
    borsh('tuple-bool-true', 'Single-item tuple (bool): the pump-fun OptionBool alias, some-style.', { tuple: ['bool'] }, [true]),
    borsh('tuple-bool-false', 'Single-item tuple (bool): the pump-fun OptionBool alias, false.', { tuple: ['bool'] }, [false]),
    borsh(
        'tuple-u8-u64',
        'Tuple (u8, u64): items concatenated with no prefix (kitchen-sink Split variant payload shape).',
        { tuple: ['u8', 'u64'] },
        [3, '9000000000'],
    ),
    borsh(
        'tuple-string-pubkey',
        'Tuple (string, pubkey): mixed-width items.',
        { tuple: ['string', 'pubkey'] },
        ['seed', '11111111111111111111111111111111'],
    ),
];

// ---------------------------------------------------------------------------
// base58.json
// ---------------------------------------------------------------------------

/** Bidirectional base58 vector: decode(base58)==hex AND encode(hex)==base58. */
function base58Pair(id, description, base58String, as = 'bytes') {
    return {
        id: `base58-${id}`,
        mode: 'base58',
        description,
        input: { base58: base58String, as },
        expected: { hex: toHex(b58decode(base58String)) },
    };
}

function base58Error(id, description, base58String, as = 'bytes') {
    return {
        id: `base58-${id}`,
        mode: 'base58',
        description,
        input: { base58: base58String, as },
        expected: { error: true },
    };
}

const KNOWN_ADDRESSES = [
    ['system-program', '11111111111111111111111111111111', 'The system program id decodes to 32 zero bytes.'],
    ['pump-program', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'The pump-fun program id.'],
    ['memo-program', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'The memo program id.'],
    ['token-program', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'The SPL token program id.'],
    ['ata-program', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'The associated-token-account program id.'],
    ['wrapped-sol', 'So11111111111111111111111111111111111111112', 'The wrapped SOL mint (embedded "1" run).'],
    ['vote-program', 'Vote111111111111111111111111111111111111111', 'The vote program id (long trailing "1" run).'],
    [
        'recent-blockhashes-sysvar',
        'SysvarRecentB1ockHashes11111111111111111111',
        'The recent-blockhashes sysvar (lua smoke-test key).',
    ],
    ['wallet-1', '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh', 'A wallet key from the python smoke test.'],
    ['wallet-2', 'GJRYBLa6XpfswT1AN5tpGp8NHtUirwAdTPdSYXsW9L3S', 'A wallet key from the ruby smoke test.'],
    ['wallet-3', 'GpHzfnYHnJNqRmL4mNQu7BFFcBcwTakTQEDrCdcVm5Zt', 'A wallet key from the php smoke test.'],
    ['wallet-4', '7g2eDDDvbWoUjjSMSGA4WdQhSBNRRGTRwY4MQer2hUYy', 'A wallet key from the php smoke test.'],
    ['dummy-program', 'Dummy11111111111111111111111111111111111111', 'The dummy fixture program id.'],
];

const base58Vectors = [
    ...KNOWN_ADDRESSES.map(([id, addr, desc]) => base58Pair(id, desc, addr, 'pubkey')),
    base58Pair('generic-hello-world', 'Generic byte-string round-trip (lua smoke-test case).', b58encode(utf8('hello world'))),
    base58Pair(
        'leading-zeros',
        'Leading zero bytes map to leading "1" characters one-for-one.',
        b58encode(fromHex('0000010203')),
    ),
    base58Pair('single-zero-byte', 'A single zero byte encodes as "1".', '1'),
    base58Pair('empty', 'Empty input encodes as the empty string.', ''),
    base58Pair('single-byte-ff', 'A single 0xff byte.', b58encode(fromHex('ff'))),
    base58Error(
        'invalid-char-l0l',
        'Invalid characters: "l" and "0" are not in the base58 alphabet (ruby smoke-test case).',
        'l0l',
    ),
    base58Error('invalid-char-0oil', 'All four excluded alphabet characters: 0, O, I, l.', '0OIl'),
    base58Error('invalid-char-punct', 'Punctuation is not in the base58 alphabet.', 'abc!def'),
    base58Error(
        'pubkey-too-short',
        'Valid base58 that decodes to 2 bytes: must be rejected when parsed as a 32-byte pubkey.',
        b58encode(fromHex('0102')),
        'pubkey',
    ),
    base58Error(
        'pubkey-31-bytes',
        'Valid base58 that decodes to 31 bytes: one short of a pubkey.',
        b58encode(new Uint8Array(31).fill(7)),
        'pubkey',
    ),
    base58Error(
        'pubkey-33-bytes',
        'Valid base58 that decodes to 33 bytes: one over a pubkey.',
        b58encode(new Uint8Array(33).fill(7)),
        'pubkey',
    ),
];

// ---------------------------------------------------------------------------
// sha256.json
// ---------------------------------------------------------------------------

function sha256Vector(id, description, input, bytes) {
    return {
        id: `sha256-${id}`,
        mode: 'sha256',
        description,
        input,
        expected: { hex: sha256(bytes) },
    };
}

const NIST_TWO_BLOCK = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
const sha256Vectors = [
    sha256Vector('empty', 'NIST vector: the empty message.', { utf8: '' }, utf8('')),
    sha256Vector('abc', 'NIST vector: "abc" (lua smoke-test case).', { utf8: 'abc' }, utf8('abc')),
    sha256Vector(
        'nist-448-bit',
        'NIST vector: the 448-bit two-block message.',
        { utf8: NIST_TWO_BLOCK },
        utf8(NIST_TWO_BLOCK),
    ),
    sha256Vector(
        'a-x-55',
        'Padding boundary: 55 bytes is the largest single-block message.',
        { repeat: { utf8: 'a', count: 55 } },
        utf8('a'.repeat(55)),
    ),
    sha256Vector(
        'a-x-56',
        'Padding boundary: 56 bytes forces the length into a second block.',
        { repeat: { utf8: 'a', count: 56 } },
        utf8('a'.repeat(56)),
    ),
    sha256Vector(
        'a-x-64',
        'Block boundary: exactly one 64-byte block of input.',
        { repeat: { utf8: 'a', count: 64 } },
        utf8('a'.repeat(64)),
    ),
    sha256Vector(
        'a-x-1000',
        'Long input: 1000 repetitions of "a".',
        { repeat: { utf8: 'a', count: 1000 } },
        utf8('a'.repeat(1000)),
    ),
    sha256Vector(
        'a-x-1000000',
        'NIST vector: one million repetitions of "a".',
        { repeat: { utf8: 'a', count: 1000000 } },
        utf8('a'.repeat(1000000)),
    ),
    sha256Vector('binary-bd', 'Binary input: the single byte 0xbd.', { hex: 'bd' }, fromHex('bd')),
    sha256Vector(
        'binary-00-ff',
        'Binary input: all 256 byte values in order.',
        { hex: toHex(Uint8Array.from({ length: 256 }, (_, i) => i)) },
        Uint8Array.from({ length: 256 }, (_, i) => i),
    ),
];

// ---------------------------------------------------------------------------
// pda.json
// ---------------------------------------------------------------------------

const SYSTEM_ID = '11111111111111111111111111111111';
const PUMP_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MEMO_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TOKEN_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WALLET_RUBY = 'GJRYBLa6XpfswT1AN5tpGp8NHtUirwAdTPdSYXsW9L3S';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

const seedBytes = (seeds) => seeds.map((hex) => Buffer.from(fromHex(hex)));

function findPda(id, description, seedsHex, programId) {
    const [address, bump] = PublicKey.findProgramAddressSync(seedBytes(seedsHex), new PublicKey(programId));
    return {
        id: `pda-find-${id}`,
        mode: 'pda',
        description,
        input: { op: 'findProgramAddress', seeds: seedsHex, programId },
        expected: { address: address.toBase58(), bump },
    };
}

function createPda(id, description, seedsHex, programId) {
    let expected;
    try {
        expected = {
            address: PublicKey.createProgramAddressSync(seedBytes(seedsHex), new PublicKey(programId)).toBase58(),
        };
    } catch {
        expected = { error: true };
    }
    return {
        id: `pda-create-${id}`,
        mode: 'pda',
        description,
        input: { op: 'createProgramAddress', seeds: seedsHex, programId },
        expected,
    };
}

function onCurve(id, description, base58Address) {
    let result;
    try {
        result = PublicKey.isOnCurve(b58decode(base58Address));
    } catch {
        result = false;
    }
    return {
        id: `pda-curve-${id}`,
        mode: 'pda',
        description,
        input: { op: 'isOnCurve', bytes: toHex(b58decode(base58Address)) },
        expected: { onCurve: result },
    };
}

const hx = (s) => toHex(utf8(s));
const pdaVectors = [
    // findProgramAddress (lifted from the four smoke tests).
    findPda('global-pump', 'Python smoke test: bump 255, the first candidate is already off-curve.', [hx('global')], PUMP_ID),
    findPda(
        'vault-23-pump',
        'Python smoke test: bump 250 — bumps 255..251 all land on the curve and must be rejected by the loop.',
        [hx('vault'), '23'],
        PUMP_ID,
    ),
    findPda(
        'user-stats-system',
        'Python smoke test: bump 249, multiple seeds including a pubkey.',
        [hx('user-stats'), toHex(b58decode(MEMO_ID)), '06'],
        SYSTEM_ID,
    ),
    findPda('vault-wallet-system', 'Ruby smoke test: string + pubkey seeds, bump 255.', [hx('vault'), toHex(b58decode(WALLET_RUBY))], SYSTEM_ID),
    findPda(
        'vault1-wallet-token',
        'Ruby smoke test: bump 253, exercises the bump loop.',
        [hx('vault1'), toHex(b58decode(WALLET_RUBY))],
        TOKEN_ID,
    ),
    findPda(
        'associated-token-account',
        'Ruby smoke test: the canonical ATA derivation (owner, token program, mint).',
        [toHex(b58decode(WALLET_RUBY)), toHex(b58decode(TOKEN_ID)), toHex(b58decode(WRAPPED_SOL))],
        ATA_ID,
    ),
    findPda('vault-pump-system', 'PHP smoke test: string + pubkey seeds under the system program.', [hx('vault'), toHex(b58decode(PUMP_ID))], SYSTEM_ID),
    findPda('metadata-metaplex-pump', 'PHP smoke test: two string seeds.', [hx('metadata'), hx('metaplex')], PUMP_ID),
    findPda(
        'u64-seed-memo',
        'PHP smoke test: a u64 LE byte seed before a string seed, bump 254.',
        [toHex(codecFor('u64').encode(42n)), hx('global')],
        MEMO_ID,
    ),
    findPda(
        'vault-user9-system',
        'PHP smoke test: bump 251 — the on-curve rejection loop runs several times.',
        [hx('vault'), hx('user9')],
        SYSTEM_ID,
    ),
    findPda('vault-system', 'Lua smoke test: a single string seed, bump 254.', [hx('vault')], SYSTEM_ID),
    findPda('vault-memo-token', 'Lua smoke test: string + pubkey seeds, bump 254.', [hx('vault'), toHex(b58decode(MEMO_ID))], TOKEN_ID),
    findPda(
        'metadata-binary-pump',
        'Lua smoke test: string + raw binary + string seeds, bump 255.',
        [hx('metadata'), '01020304', hx('pump')],
        PUMP_ID,
    ),
    // createProgramAddress.
    createPda(
        'vault-user9-bump-251',
        'PHP smoke test: createProgramAddress with the found bump reproduces the findProgramAddress result.',
        [hx('vault'), hx('user9'), 'fb'],
        SYSTEM_ID,
    ),
    createPda(
        'vault-user9-bump-255-on-curve',
        'PHP smoke test: bump 255 lands ON the ed25519 curve for these seeds and must be rejected.',
        [hx('vault'), hx('user9'), 'ff'],
        SYSTEM_ID,
    ),
    createPda(
        'vault-23-bump-250',
        'Python smoke test: createProgramAddress reproduces the bump-250 findProgramAddress result.',
        [hx('vault'), '23', 'fa'],
        PUMP_ID,
    ),
    createPda(
        'vault-23-bump-255-on-curve',
        'Python smoke test: bump 255 is on-curve for these seeds and must fail with a typed PDA error.',
        [hx('vault'), '23', 'ff'],
        PUMP_ID,
    ),
    createPda(
        'vault1-wallet-bump-253',
        'Ruby smoke test: createProgramAddress with bump 253 under the token program.',
        [hx('vault1'), toHex(b58decode(WALLET_RUBY)), 'fd'],
        TOKEN_ID,
    ),
    {
        id: 'pda-create-seed-too-long',
        mode: 'pda',
        description: 'A 33-byte seed exceeds the 32-byte maximum and must be rejected.',
        input: { op: 'createProgramAddress', seeds: ['ab'.repeat(33)], programId: SYSTEM_ID },
        expected: { error: true },
    },
    {
        id: 'pda-create-too-many-seeds',
        mode: 'pda',
        description: 'Seventeen seeds exceed the 16-seed maximum and must be rejected.',
        input: { op: 'createProgramAddress', seeds: Array.from({ length: 17 }, () => '01'), programId: SYSTEM_ID },
        expected: { error: true },
    },
    // isOnCurve classification.
    onCurve('all-zero-pubkey', 'The system program id (32 zero bytes) is a valid curve point.', SYSTEM_ID),
    onCurve('wallet-key', 'A real wallet key (ed25519 public key) is on the curve (ruby smoke-test case).', WALLET_RUBY),
    onCurve('memo-program-key', 'The memo program id happens to be on the curve (lua smoke-test case).', MEMO_ID),
    onCurve(
        'derived-pda-1',
        'The PDA derived from ["vault","user9"]+bump 251 is off the curve (php smoke-test case).',
        PublicKey.createProgramAddressSync([Buffer.from('vault'), Buffer.from('user9'), Buffer.from([251])], new PublicKey(SYSTEM_ID)).toBase58(),
    ),
    onCurve(
        'derived-pda-2',
        'The PDA derived from ["global"]+bump 255 under pump-fun is off the curve (python smoke-test case).',
        PublicKey.createProgramAddressSync([Buffer.from('global'), Buffer.from([255])], new PublicKey(PUMP_ID)).toBase58(),
    ),
    {
        id: 'pda-curve-y-equals-p',
        mode: 'pda',
        description:
            'Invalid point encoding: y = p (non-canonical, must not decode as a curve point). ' +
            'Little-endian bytes of 2^255-19.',
        input: { op: 'isOnCurve', bytes: 'ed' + 'ff'.repeat(30) + '7f' },
        expected: { onCurve: false },
    },
    {
        id: 'pda-curve-y-max',
        mode: 'pda',
        description: 'Invalid point encoding: all bytes 0xff (y = 2^255-1 after masking the sign bit, y >= p).',
        input: { op: 'isOnCurve', bytes: 'ff'.repeat(32) },
        expected: { onCurve: false },
    },
    {
        id: 'pda-curve-y-equals-p-minus-1',
        mode: 'pda',
        description:
            'Canonical but off-curve encoding: y = p-1 with sign bit clear. ' +
            `Reference result pinned from @solana/web3.js isOnCurve: ${PublicKey.isOnCurve(fromHex('ec' + 'ff'.repeat(30) + '7f'))}.`,
        input: { op: 'isOnCurve', bytes: 'ec' + 'ff'.repeat(30) + '7f' },
        expected: { onCurve: PublicKey.isOnCurve(fromHex('ec' + 'ff'.repeat(30) + '7f')) },
    },
    {
        id: 'pda-curve-y-equals-1',
        mode: 'pda',
        description: 'The encoding of y=1 (the identity point) is a valid curve point.',
        input: { op: 'isOnCurve', bytes: '01' + '00'.repeat(31) },
        expected: { onCurve: PublicKey.isOnCurve(fromHex('01' + '00'.repeat(31))) },
    },
];

// ---------------------------------------------------------------------------
// instructions.json
// ---------------------------------------------------------------------------

const u32 = (n) => new Uint8Array(codecFor('u32').encode(n));
const u64 = (v) => new Uint8Array(codecFor('u64').encode(BigInt(v)));
const str32 = (s) => new Uint8Array(codecFor('string').encode(s));
const pk = (addr) => b58decode(addr);

function meta(name, isSigner, isWritable, address) {
    return address === undefined ? { name, isSigner, isWritable } : { name, isSigner, isWritable, address };
}

const PHP_SOURCE = 'GpHzfnYHnJNqRmL4mNQu7BFFcBcwTakTQEDrCdcVm5Zt';
const PHP_DEST = '7g2eDDDvbWoUjjSMSGA4WdQhSBNRRGTRwY4MQer2hUYy';

function transferSolVector(id, description, source, destination, amount) {
    return {
        id: `ix-system-transfer-sol-${id}`,
        mode: 'instruction',
        description,
        input: {
            program: 'system',
            instruction: 'transferSol',
            accounts: { source, destination },
            args: { amount },
        },
        expected: {
            programId: SYSTEM_ID,
            dataHex: toHex(concat(u32(2), u64(amount))),
            accounts: [meta('source', true, true, source), meta('destination', false, true, destination)],
        },
    };
}

const buyFlags = [
    ['global', false, false],
    ['feeRecipient', false, true],
    ['mint', false, false],
    ['bondingCurve', false, true],
    ['associatedBondingCurve', false, true],
    ['associatedUser', false, true],
    ['user', true, true],
    ['systemProgram', false, false],
    ['tokenProgram', false, false],
    ['creatorVault', false, true],
    ['eventAuthority', false, false],
    ['program', false, false],
    ['globalVolumeAccumulator', false, false],
    ['userVolumeAccumulator', false, true],
    ['feeConfig', false, false],
    ['feeProgram', false, false],
];
const BUY_DISC = '66063d1201daebea';
const CREATE_DISC = '181ec828051c0777';

function buyDataHex(amount, maxSolCost, trackVolumeBool) {
    return toHex(concat(fromHex(BUY_DISC), u64(amount), u64(maxSolCost), Uint8Array.of(trackVolumeBool ? 1 : 0)));
}

const LUA_PK = MEMO_ID; // the lua smoke test passes the memo program id for every buy account
const instructionVectors = [
    transferSolVector(
        'one-million',
        'System transferSol: u32 LE field discriminator 2 + u64 LE amount (python/php smoke-test case).',
        PHP_SOURCE,
        PHP_DEST,
        '1000000',
    ),
    transferSolVector(
        'u64-max',
        'System transferSol with the maximum u64 amount (lua smoke-test case).',
        MEMO_ID,
        TOKEN_ID,
        '18446744073709551615',
    ),
    transferSolVector(
        'ruby-amount',
        'System transferSol with amount 1234567890 (ruby smoke-test case).',
        WALLET_RUBY,
        WRAPPED_SOL,
        '1234567890',
    ),
    {
        id: 'ix-system-transfer-sol-truncated-decode',
        mode: 'instruction',
        description: 'Decoding transferSol instruction data that ends after the discriminator must fail.',
        input: { program: 'system', instruction: 'transferSol', dataHex: '02000000', direction: 'decode' },
        expected: { error: true },
    },
    {
        id: 'ix-system-create-account-with-seed',
        mode: 'instruction',
        description:
            'System createAccountWithSeed (ruby smoke-test case): u32 disc 3 + base pubkey + ' +
            'u32-prefixed seed string + u64 amount + u64 space + programAddress pubkey.',
        input: {
            program: 'system',
            instruction: 'createAccountWithSeed',
            accounts: { payer: WALLET_RUBY, newAccount: WRAPPED_SOL, baseAccount: WALLET_RUBY },
            args: {
                base: WALLET_RUBY,
                seed: 'hello',
                amount: '42',
                space: '165',
                programAddress: SYSTEM_ID,
            },
        },
        expected: {
            programId: SYSTEM_ID,
            dataHex: toHex(
                concat(u32(3), pk(WALLET_RUBY), str32('hello'), u64('42'), u64('165'), pk(SYSTEM_ID)),
            ),
            accounts: [
                meta('payer', true, true, WALLET_RUBY),
                meta('newAccount', false, true, WRAPPED_SOL),
                meta('baseAccount', true, false, WALLET_RUBY),
            ],
        },
    },
    {
        id: 'ix-memo-add-memo-ascii',
        mode: 'instruction',
        description:
            'Memo addMemo: the data is the raw UTF-8 bytes of the memo (a remainder string, no prefix). ' +
            'Account metas are caller-supplied remaining accounts and are not pinned.',
        input: { program: 'memo', instruction: 'addMemo', accounts: {}, args: { memo: 'hello memo' } },
        expected: { programId: MEMO_ID, dataHex: toHex(utf8('hello memo')) },
    },
    {
        id: 'ix-memo-add-memo-punctuated',
        mode: 'instruction',
        description: 'Memo addMemo with punctuation (ruby smoke-test case).',
        input: { program: 'memo', instruction: 'addMemo', accounts: {}, args: { memo: 'Hello, Solana!' } },
        expected: { programId: MEMO_ID, dataHex: toHex(utf8('Hello, Solana!')) },
    },
    {
        id: 'ix-memo-add-memo-multibyte',
        mode: 'instruction',
        description: 'Memo addMemo with multibyte UTF-8 (ruby smoke-test case): byte length differs from character count.',
        input: { program: 'memo', instruction: 'addMemo', accounts: {}, args: { memo: 'héllo ✨' } },
        expected: { programId: MEMO_ID, dataHex: toHex(utf8('héllo ✨')) },
    },
    {
        id: 'ix-pump-buy',
        mode: 'instruction',
        description:
            'Pump-fun buy (lua smoke-test case): 8-byte Anchor discriminator 66063d1201daebea + ' +
            'u64 amount + u64 maxSolCost + OptionBool tuple (1 byte). All 16 accounts supplied explicitly.',
        input: {
            program: 'pump',
            instruction: 'buy',
            accounts: Object.fromEntries(buyFlags.map(([name]) => [name, LUA_PK])),
            args: { amount: '42', maxSolCost: '99', trackVolume: [true] },
        },
        expected: {
            programId: PUMP_ID,
            dataHex: buyDataHex('42', '99', true),
            accounts: buyFlags.map(([name, s, w]) => meta(name, s, w, LUA_PK)),
        },
    },
    {
        id: 'ix-pump-buy-u64-max',
        mode: 'instruction',
        description: 'Pump-fun buy with the maximum u64 amount (php smoke-test case). Data bytes only.',
        input: {
            program: 'pump',
            instruction: 'buy',
            accounts: Object.fromEntries(buyFlags.map(([name]) => [name, PHP_SOURCE])),
            args: { amount: '18446744073709551615', maxSolCost: '1', trackVolume: [true] },
        },
        expected: {
            programId: PUMP_ID,
            dataHex: buyDataHex('18446744073709551615', '1', true),
            accounts: buyFlags.map(([name, s, w]) => meta(name, s, w, PHP_SOURCE)),
        },
    },
    {
        id: 'ix-pump-buy-default-program-accounts',
        mode: 'instruction',
        description:
            'Pump-fun buy with constant-default accounts omitted (python smoke-test case): builders that ' +
            'resolve constant public-key defaults must fill systemProgram, tokenProgram, program and ' +
            'feeProgram. Builders without default resolution may skip this vector.',
        optional: true,
        input: {
            program: 'pump',
            instruction: 'buy',
            accounts: Object.fromEntries(
                buyFlags
                    .map(([name]) => name)
                    .filter((n) => !['systemProgram', 'tokenProgram', 'program', 'feeProgram'].includes(n))
                    .map((name) => [name, '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh']),
            ),
            args: { amount: '42', maxSolCost: '43', trackVolume: [true] },
        },
        expected: {
            programId: PUMP_ID,
            dataHex: buyDataHex('42', '43', true),
            accounts: buyFlags.map(([name, s, w]) => {
                const defaults = {
                    systemProgram: SYSTEM_ID,
                    tokenProgram: TOKEN_ID,
                    program: PUMP_ID,
                    feeProgram: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
                };
                return meta(name, s, w, defaults[name] ?? '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh');
            }),
        },
    },
    {
        id: 'ix-pump-create',
        mode: 'instruction',
        description:
            'Pump-fun create (ruby smoke-test case): 8-byte Anchor discriminator + three u32-prefixed ' +
            'strings + trailing creator pubkey. Account metas pinned by flag only (addresses are caller-supplied).',
        input: {
            program: 'pump',
            instruction: 'create',
            accounts: {},
            args: {
                name: 'My Token',
                symbol: 'MTK',
                uri: 'https://example.com/meta.json',
                creator: WALLET_RUBY,
            },
        },
        expected: {
            programId: PUMP_ID,
            dataHex: toHex(
                concat(fromHex(CREATE_DISC), str32('My Token'), str32('MTK'), str32('https://example.com/meta.json'), pk(WALLET_RUBY)),
            ),
            accounts: [
                meta('mint', true, true),
                meta('mintAuthority', false, false),
                meta('bondingCurve', false, true),
                meta('associatedBondingCurve', false, true),
                meta('global', false, false),
                meta('mplTokenMetadata', false, false),
                meta('metadata', false, true),
                meta('user', true, true),
                meta('systemProgram', false, false),
                meta('tokenProgram', false, false),
                meta('associatedTokenProgram', false, false),
                meta('rent', false, false),
                meta('eventAuthority', false, false),
                meta('program', false, false),
            ],
        },
    },
    {
        id: 'ix-pump-buy-truncated-decode',
        mode: 'instruction',
        description: 'Decoding buy instruction data truncated mid-amount must fail.',
        input: { program: 'pump', instruction: 'buy', dataHex: BUY_DISC + '2a0000', direction: 'decode' },
        expected: { error: true },
    },
    {
        id: 'ix-dummy-instruction3',
        mode: 'instruction',
        description: 'Dummy instruction3: only the omitted u32 field discriminator (42) is encoded.',
        input: { program: 'dummy', instruction: 'instruction3', accounts: {}, args: {} },
        expected: { programId: 'Dummy11111111111111111111111111111111111111', dataHex: toHex(u32(42)), accounts: [] },
    },
    {
        id: 'ix-dummy-instruction5-default',
        mode: 'instruction',
        description: 'Dummy instruction5: the optional u64 argument defaults to 42 when omitted.',
        input: { program: 'dummy', instruction: 'instruction5', accounts: {}, args: {} },
        expected: { programId: 'Dummy11111111111111111111111111111111111111', dataHex: toHex(u64('42')), accounts: [] },
    },
    {
        id: 'ix-dummy-instruction5-explicit',
        mode: 'instruction',
        description: 'Dummy instruction5 with the optional argument provided (7).',
        input: { program: 'dummy', instruction: 'instruction5', accounts: {}, args: { myArgument: '7' } },
        expected: { programId: 'Dummy11111111111111111111111111111111111111', dataHex: toHex(u64('7')), accounts: [] },
    },
];

// ---------------------------------------------------------------------------
// accounts.json
// ---------------------------------------------------------------------------

const NONCE_VERSION_CURRENT = 1;
const NONCE_STATE_INITIALIZED = 1;
const BONDING_CURVE_DISC = '17b7f83760d8ac60';
const FEE_CONFIG_DISC = '8f3492bbdb7b4c9b';

function nonceBytes(authority, blockhash, lamportsPerSignature) {
    return concat(
        u32(NONCE_VERSION_CURRENT),
        u32(NONCE_STATE_INITIALIZED),
        pk(authority),
        pk(blockhash),
        u64(lamportsPerSignature),
    );
}

function nonceVector(id, description, authority, blockhash, lamportsPerSignature) {
    return {
        id: `account-system-nonce-${id}`,
        mode: 'account',
        description,
        input: {
            program: 'system',
            account: 'nonce',
            fields: {
                version: NONCE_VERSION_CURRENT, // scalar enum NonceVersion::Current as its variant index
                state: NONCE_STATE_INITIALIZED, // scalar enum NonceState::Initialized as its variant index
                authority,
                blockhash,
                lamportsPerSignature,
            },
        },
        expected: { hex: toHex(nonceBytes(authority, blockhash, lamportsPerSignature)), size: 80 },
    };
}

function bondingCurveBytes(f) {
    return concat(
        fromHex(BONDING_CURVE_DISC),
        u64(f.virtualTokenReserves),
        u64(f.virtualSolReserves),
        u64(f.realTokenReserves),
        u64(f.realSolReserves),
        u64(f.tokenTotalSupply),
        Uint8Array.of(f.complete ? 1 : 0),
        pk(f.creator),
        Uint8Array.of(f.isMayhemMode ? 1 : 0),
    );
}

function bondingCurveVector(id, description, fields) {
    return {
        id: `account-pump-bonding-curve-${id}`,
        mode: 'account',
        description,
        input: { program: 'pump', account: 'bondingCurve', fields },
        expected: { hex: toHex(bondingCurveBytes(fields)), size: 82 },
    };
}

const feesBytes = (f) => concat(u64(f.lpFeeBps), u64(f.protocolFeeBps), u64(f.creatorFeeBps));
const feeTierBytes = (t) =>
    concat(new Uint8Array(codecFor('u128').encode(BigInt(t.marketCapLamportsThreshold))), feesBytes(t.fees));

function feeConfigVector(id, description, fields) {
    const bytes = concat(
        fromHex(FEE_CONFIG_DISC),
        Uint8Array.of(fields.bump),
        pk(fields.admin),
        feesBytes(fields.flatFees),
        u32(fields.feeTiers.length),
        ...fields.feeTiers.map(feeTierBytes),
    );
    return {
        id: `account-pump-fee-config-${id}`,
        mode: 'account',
        description,
        input: { program: 'pump', account: 'feeConfig', fields },
        expected: { hex: toHex(bytes) },
    };
}

const accountVectors = [
    nonceVector(
        'python',
        'System Nonce (python smoke-test case): u32 LE scalar enums + two pubkeys + u64. 80 bytes total.',
        PUMP_ID,
        MEMO_ID,
        '5000',
    ),
    nonceVector('ruby', 'System Nonce (ruby smoke-test case).', WALLET_RUBY, WRAPPED_SOL, '5000'),
    nonceVector(
        'lua',
        'System Nonce (lua smoke-test case).',
        'Vote111111111111111111111111111111111111111',
        'SysvarRecentB1ockHashes11111111111111111111',
        '5000',
    ),
    bondingCurveVector(
        'small-values',
        'Pump-fun BondingCurve (python smoke-test case): 8-byte field discriminator 17b7f83760d8ac60 + ' +
            'five u64 + bool + pubkey + bool. 82 bytes total.',
        {
            virtualTokenReserves: '1',
            virtualSolReserves: '2',
            realTokenReserves: '3',
            realSolReserves: '4',
            tokenTotalSupply: '5',
            complete: false,
            creator: '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh',
            isMayhemMode: true,
        },
    ),
    bondingCurveVector('realistic-values', 'Pump-fun BondingCurve (ruby smoke-test case): realistic reserve values.', {
        virtualTokenReserves: '1073000000000000',
        virtualSolReserves: '30000000000',
        realTokenReserves: '793100000000000',
        realSolReserves: '0',
        tokenTotalSupply: '1000000000000000',
        complete: false,
        creator: WALLET_RUBY,
        isMayhemMode: true,
    }),
    bondingCurveVector(
        'u64-above-2pow63',
        'Pump-fun BondingCurve (php smoke-test case): virtualTokenReserves exceeds 2^63.',
        {
            virtualTokenReserves: '10000000000000000000',
            virtualSolReserves: '2',
            realTokenReserves: '3',
            realSolReserves: '4',
            tokenTotalSupply: '5',
            complete: false,
            creator: PHP_DEST,
            isMayhemMode: true,
        },
    ),
    feeConfigVector(
        'ruby',
        'Pump-fun FeeConfig (ruby smoke-test case): discriminator + u8 bump + admin pubkey + nested Fees ' +
            'struct + u32-prefixed vec of FeeTier (u128 threshold + nested Fees). Exercises u128 = 10^20.',
        {
            bump: 254,
            admin: TOKEN_ID,
            flatFees: { lpFeeBps: '30', protocolFeeBps: '10', creatorFeeBps: '5' },
            feeTiers: [
                {
                    marketCapLamportsThreshold: '100000000000000000000',
                    fees: { lpFeeBps: '100', protocolFeeBps: '50', creatorFeeBps: '25' },
                },
                { marketCapLamportsThreshold: '5', fees: { lpFeeBps: '1', protocolFeeBps: '2', creatorFeeBps: '3' } },
            ],
        },
    ),
    feeConfigVector(
        'lua',
        'Pump-fun FeeConfig (lua smoke-test case): u128 threshold with every byte 0x01, two identical tiers.',
        {
            bump: 7,
            admin: MEMO_ID,
            flatFees: { lpFeeBps: '10', protocolFeeBps: '20', creatorFeeBps: '30' },
            feeTiers: [
                {
                    marketCapLamportsThreshold: (() => {
                        let v = 0n;
                        for (let i = 15; i >= 0; i--) v = (v << 8n) | 1n;
                        return v.toString();
                    })(),
                    fees: { lpFeeBps: '1', protocolFeeBps: '2', creatorFeeBps: '3' },
                },
                {
                    marketCapLamportsThreshold: (() => {
                        let v = 0n;
                        for (let i = 15; i >= 0; i--) v = (v << 8n) | 1n;
                        return v.toString();
                    })(),
                    fees: { lpFeeBps: '1', protocolFeeBps: '2', creatorFeeBps: '3' },
                },
            ],
        },
    ),
    {
        id: 'account-system-nonce-truncated-1-byte',
        mode: 'account',
        description: 'Decoding a Nonce account from a single byte must fail (python smoke-test case).',
        input: { program: 'system', account: 'nonce', hex: '00', direction: 'decode' },
        expected: { error: true },
    },
    {
        id: 'account-system-nonce-truncated-5-bytes',
        mode: 'account',
        description: 'Decoding a Nonce account from five zero bytes must fail (lua smoke-test case).',
        input: { program: 'system', account: 'nonce', hex: '0000000000', direction: 'decode' },
        expected: { error: true },
    },
    {
        id: 'account-pump-bonding-curve-truncated',
        mode: 'account',
        description: 'Decoding a BondingCurve account from 81 of its 82 bytes must fail.',
        input: {
            program: 'pump',
            account: 'bondingCurve',
            hex: toHex(
                bondingCurveBytes({
                    virtualTokenReserves: '1',
                    virtualSolReserves: '2',
                    realTokenReserves: '3',
                    realSolReserves: '4',
                    tokenTotalSupply: '5',
                    complete: false,
                    creator: '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh',
                    isMayhemMode: true,
                }),
            ).slice(0, 81 * 2),
            direction: 'decode',
        },
        expected: { error: true },
    },
    {
        id: 'account-system-nonce-unknown-enum-variant',
        mode: 'account',
        description:
            'A Nonce account whose state field holds the unknown variant index 99. Strict decoders ' +
            '(python IntEnum, php backed enums) reject it; decoders that surface scalar enums as raw ' +
            'integers (lua) accept it and may skip this vector.',
        optional: true,
        input: {
            program: 'system',
            account: 'nonce',
            hex: toHex(concat(u32(1), u32(99), pk(PUMP_ID), pk(MEMO_ID), u64('5000'))),
            direction: 'decode',
        },
        expected: { error: true },
    },
];

// ---------------------------------------------------------------------------
// Sanity checks against constants hardcoded in the renderer smoke tests.
// A failure here means the reference implementation and the generated clients
// disagree -- investigate before pinning.
// ---------------------------------------------------------------------------

function sanityChecks() {
    // base58 (python/ruby/php/lua smoke tests).
    assertEq(toHex(b58decode(SYSTEM_ID)), '00'.repeat(32), 'system id decodes to 32 zero bytes');
    assertEq(b58encode(new Uint8Array(32)), SYSTEM_ID, '32 zero bytes encode to the system id');

    // sha256 (lua smoke test).
    assertEq(sha256(utf8('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256("")');
    assertEq(sha256(utf8('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc")');
    // NIST published digests.
    assertEq(
        sha256(utf8(NIST_TWO_BLOCK)),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
        'sha256(NIST 448-bit)',
    );
    assertEq(
        sha256(utf8('a'.repeat(1000000))),
        'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
        'sha256(a x 1e6)',
    );

    // Borsh primitives (python/php smoke tests).
    assertEq(encodeHex('u64', '18446744073709551615'), 'ff'.repeat(8), 'u64 max');
    assertEq(encodeHex('i64', '-1'), 'ff'.repeat(8), 'i64 -1');
    assertEq(encodeHex('i128', '-1'), 'ff'.repeat(16), 'i128 -1');
    assertEq(encodeHex('u128', '170141183460469231731687303715884105728'), '00'.repeat(15) + '80', 'u128 2^127');
    assertEq(encodeHex('string', 'hi'), '020000006869', 'string "hi"');
    assertEq(encodeHex('string', 'hello'), '0500000068656c6c6f', 'string "hello"');
    assertEq(encodeHex({ option: 'u64' }, null), '00', 'option none');
    assertEq(encodeHex({ option: 'u64' }, { some: '7' }), '010700000000000000', 'option some(7)');
    assertEq(encodeHex('shortu16', 0x7f), '7f', 'shortU16 0x7f');
    assertEq(encodeHex('shortu16', 0x80), '8001', 'shortU16 0x80');
    assertEq(encodeHex({ vec: 'u16' }, [1, 2, 3]), '03000000010002000300', 'vec<u16> [1,2,3]');
    assertEq(encodeHex({ map: { key: 'u8', value: 'u8' } }, [[1, 10], [3, 30]]), '02000000010a031e', 'map {1:10,3:30}');
    assertEq(
        encodeHex({ set: 'string' }, ['a', 'b']),
        '02000000' + '0100000061' + '0100000062',
        'set {"a","b"}',
    );
    assertEq(encodeHex({ tuple: ['bool'] }, [true]), '01', 'OptionBool tuple [true]');

    // transferSol data (python/php smoke tests).
    assertEq(toHex(concat(u32(2), u64('1000000'))), '0200000040420f0000000000', 'transferSol data');

    // pump buy data (php smoke test: ff*8 amount, 1 maxSolCost, [true]).
    assertEq(
        buyDataHex('18446744073709551615', '1', true),
        '66063d1201daebea' + 'ff'.repeat(8) + '0100000000000000' + '01',
        'buy data (php)',
    );
    // pump buy data (python smoke test: 42, 43, [true]).
    assertEq(
        buyDataHex('42', '43', true),
        '66063d1201daebea' + '2a00000000000000' + '2b00000000000000' + '01',
        'buy data (python)',
    );

    // Account sizes and prefixes (python/ruby/php smoke tests).
    const nonce = nonceBytes(PUMP_ID, MEMO_ID, '5000');
    assertEq(nonce.length, 80, 'Nonce size');
    assertEq(toHex(nonce.slice(0, 8)), '0100000001000000', 'Nonce enum prefix');
    const curve = bondingCurveBytes({
        virtualTokenReserves: '1',
        virtualSolReserves: '2',
        realTokenReserves: '3',
        realSolReserves: '4',
        tokenTotalSupply: '5',
        complete: false,
        creator: '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh',
        isMayhemMode: true,
    });
    assertEq(curve.length, 82, 'BondingCurve size');
    assertEq(toHex(curve.slice(0, 8)), BONDING_CURVE_DISC, 'BondingCurve discriminator');

    // PDA vectors hardcoded in the smoke tests.
    const expectPda = (seeds, programId, address, bump, label) => {
        const [a, b] = PublicKey.findProgramAddressSync(seeds, new PublicKey(programId));
        assertEq(a.toBase58(), address, `${label} address`);
        assertEq(b, bump, `${label} bump`);
    };
    expectPda([Buffer.from('global')], PUMP_ID, '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', 255, 'python pda 1');
    expectPda([Buffer.from('vault'), Buffer.from([0x23])], PUMP_ID, '76jNgxjtv5f2MkuXWMkNKdqsnL8yMm3jnmBez2Bn3Mbz', 250, 'python pda 2');
    expectPda(
        [Buffer.from('user-stats'), Buffer.from(b58decode(MEMO_ID)), Buffer.from([6])],
        SYSTEM_ID,
        '8SWwACT3P72rLtLx9rRirNG5ezxQ17pPwTiNYoZN1MUP',
        249,
        'python pda 3',
    );
    expectPda(
        [Buffer.from('vault'), Buffer.from(b58decode(WALLET_RUBY))],
        SYSTEM_ID,
        '7FTcQzuHk9kRD8DHzSRk1TQdrFXLxtKaMghEGLoYZWZU',
        255,
        'ruby pda 1',
    );
    expectPda(
        [Buffer.from('vault1'), Buffer.from(b58decode(WALLET_RUBY))],
        TOKEN_ID,
        'FBzBWN9bWEKMxzTKNnT52ZDrSL3aAb8Z41fzRPSK7V11',
        253,
        'ruby pda 2',
    );
    expectPda(
        [Buffer.from(b58decode(WALLET_RUBY)), Buffer.from(b58decode(TOKEN_ID)), Buffer.from(b58decode(WRAPPED_SOL))],
        ATA_ID,
        'CPXWnhCPGCnyJJw8ZxABpB88n8LjqUgzLv8R7kor9xgT',
        255,
        'ruby pda 3 (ata)',
    );
    expectPda(
        [Buffer.from('vault'), Buffer.from(b58decode(PUMP_ID))],
        SYSTEM_ID,
        '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh',
        255,
        'php pda 1',
    );
    expectPda([Buffer.from('metadata'), Buffer.from('metaplex')], PUMP_ID, 'CPkf1tvGMVF5aGMnBQ27HE13xji6PCy3j6fAFysfNCN4', 255, 'php pda 2');
    expectPda(
        [Buffer.from(u64('42')), Buffer.from('global')],
        MEMO_ID,
        'EH2Du28uF223ZMiJFLvH3v5Ur7JbE3vmyz4qC8ktVERG',
        254,
        'php pda 3',
    );
    expectPda([Buffer.from('vault'), Buffer.from('user9')], SYSTEM_ID, '6XTsA8455CLY6YFgrbxVh9QgGb8424aKUYX4ZmyvfuHA', 251, 'php pda 4');
    expectPda([Buffer.from('vault')], SYSTEM_ID, '58CDQ9Qgw1ZPedjaTtwrR2MSG4EmmguHSPE2bFtyfinD', 254, 'lua pda 1');
    expectPda(
        [Buffer.from('vault'), Buffer.from(b58decode(MEMO_ID))],
        TOKEN_ID,
        'GpAyoYkFKLY8WaYhikv4YUn3FNzzTzvSp2sAx35Cz3te',
        254,
        'lua pda 2',
    );
    expectPda(
        [Buffer.from('metadata'), Buffer.from([1, 2, 3, 4]), Buffer.from('pump')],
        PUMP_ID,
        'sBvFxVvS2WaUNTiGC7KBzTFrhRWZTyNpRC2AgBRT8yo',
        255,
        'lua pda 3',
    );

    // On-curve checks asserted in the ruby/lua smoke tests.
    assertEq(PublicKey.isOnCurve(b58decode(SYSTEM_ID)), true, 'system id on curve');
    assertEq(PublicKey.isOnCurve(b58decode(WALLET_RUBY)), true, 'wallet on curve');
    assertEq(PublicKey.isOnCurve(b58decode(MEMO_ID)), true, 'memo id on curve');
    assertEq(
        PublicKey.isOnCurve(
            PublicKey.createProgramAddressSync(
                [Buffer.from('vault'), Buffer.from('user9'), Buffer.from([251])],
                new PublicKey(SYSTEM_ID),
            ).toBytes(),
        ),
        false,
        'derived pda off curve',
    );

    // createProgramAddress on-curve rejections asserted in the smoke tests.
    for (const [seeds, programId, label] of [
        [[Buffer.from('vault'), Buffer.from('user9'), Buffer.from([255])], SYSTEM_ID, 'php bump 255 on-curve'],
        [[Buffer.from('vault'), Buffer.from([0x23]), Buffer.from([255])], PUMP_ID, 'python bump 255 on-curve'],
    ]) {
        let threw = false;
        try {
            PublicKey.createProgramAddressSync(seeds, new PublicKey(programId));
        } catch {
            threw = true;
        }
        assertEq(threw, true, label);
    }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

sanityChecks();

const FILES = {
    'borsh-primitives.json': borshVectors,
    'base58.json': base58Vectors,
    'sha256.json': sha256Vectors,
    'pda.json': pdaVectors,
    'instructions.json': instructionVectors,
    'accounts.json': accountVectors,
};

mkdirSync(OUT_DIR, { recursive: true });
const allIds = new Set();
for (const [file, vectors] of Object.entries(FILES)) {
    for (const v of vectors) {
        if (allIds.has(v.id)) throw new Error(`duplicate vector id: ${v.id}`);
        allIds.add(v.id);
    }
    writeFileSync(join(OUT_DIR, file), JSON.stringify(vectors, null, 2) + '\n');
    console.log(`${file}: ${vectors.length} vectors`);
}
console.log(`total: ${allIds.size} vectors (sanity checks passed)`);
