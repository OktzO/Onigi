import { encodeNode as wrbEncodeNode, decodeNode as wrbDecodeNode } from 'whatsapp-rust-bridge';
import * as constants from './constants.js';
import { decompressingIfRequired, decodeDecompressedBinaryNode } from './decode.js';
import { encodeBinaryNode } from './encode.js';
/** ponytail: numeric attrs diverge between encoders; adapter normalizes to JS semantics (strings only) */
const RUST_ENABLED = process.env.ONIGI_RUST_WABINARY !== '0';
/** WRB decode is opt-in: node-to-plain conversion (wrapper alloc + free + copies) benches ~2x slower than the JS decoder */
const RUST_DECODE_ENABLED = RUST_ENABLED && process.env.ONIGI_RUST_WABINARY_DECODE === '1';
const FALLBACK_REPORT_EVERY = 100;
let fallbacks = 0;
const logFallback = (err) => {
    fallbacks += 1;
    if (fallbacks === 1 || fallbacks % FALLBACK_REPORT_EVERY === 0) {
        console.warn(`[rust-adapter] WRB failed (${err?.message ?? err}), falling back to JS WABinary (occurrence ${fallbacks})`);
    }
};
/** whether WRB encodes a node differently from the JS encoder, so JS must own it.
 *  Measured divergences: a non-string attr is stringified by WRB and dropped by JS,
 *  and an empty-string attr is dropped by WRB and kept by JS. Both encode without
 *  throwing, so the catch below never sees them. */
const divergesFromJs = (node) => {
    if (!node || typeof node !== 'object') {
        return false;
    }
    for (const key of Object.keys(node.attrs || {})) {
        const value = node.attrs[key];
        if (value === undefined || value === null) {
            continue;
        }
        if (typeof value !== 'string' || value === '') {
            return true;
        }
    }
    if (Array.isArray(node.content)) {
        return node.content.some(item => item && typeof item === 'object'
            && !Buffer.isBuffer(item)
            && !(item instanceof Uint8Array)
            && divergesFromJs(item));
    }
    return false;
};
/** convert a WRB InternalBinaryNode tree into a plain JS BinaryNode (binary content becomes Buffer like the JS decoder); frees each wasm wrapper exactly once */
const toPlainNode = (node) => {
    // capture getters once — re-reading `content` re-wraps child pointers and would double-free
    const tag = node.tag;
    const attrs = node.attrs;
    const content = node.content;
    node.free();
    if (Array.isArray(content)) {
        return {
            tag,
            attrs,
            content: content.map(child => child && typeof child.tag === 'string'
                ? toPlainNode(child)
                : child)
        };
    }
    return { tag, attrs, content: content instanceof Uint8Array ? Buffer.from(content) : content };
};
/** encode a BinaryNode to bytes; byte-identical to JS encodeBinaryNode for well-formed nodes */
export const encodeBinaryNodeRust = (node) => {
    if (!RUST_ENABLED || divergesFromJs(node)) {
        return encodeBinaryNode(node);
    }
    try {
        return Buffer.from(wrbEncodeNode(node));
    }
    catch (err) {
        logFallback(err);
        return encodeBinaryNode(node);
    }
};
/** decode a (possibly compressed) frame into a plain JS BinaryNode */
export const decodeBinaryNodeRust = async (buff) => {
    if (!RUST_DECODE_ENABLED) {
        const decompBuff = await decompressingIfRequired(buff);
        return decodeDecompressedBinaryNode(decompBuff, constants);
    }
    try {
        return toPlainNode(wrbDecodeNode(buff instanceof Uint8Array ? buff : new Uint8Array(buff.buffer, buff.byteOffset, buff.byteLength)));
    }
    catch (err) {
        logFallback(err);
        const decompBuff = await decompressingIfRequired(buff);
        return decodeDecompressedBinaryNode(decompBuff, constants);
    }
};
