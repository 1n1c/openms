import { inflateSync, constants } from "node:zlib";
import { keyStream } from "./crypto.js";
import { Reader } from "./reader.js";

const MAX_CANVAS_DIMENSION = 65535;
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;
const SYNC_FLUSH_TRAILER = Buffer.from([0, 0, 255, 255]);
/** @param {Buffer} payload @returns {Buffer} */
function compressedBytes(payload) {
  // ZLZ accepts a normal zlib stream or length-prefixed, independently encrypted chunks.
  if (
    payload.length >= 2 &&
    (payload[0] & 15) === 8 &&
    ((payload[0] << 8) + payload[1]) % 31 === 0
  ) {
    return payload;
  }
  const reader = new Reader(payload);
  const chunks = [];
  // Each iteration consumes a positive chunk and its four-byte length.
  while (reader.pos < reader.end) {
    const size = reader.u32();
    if (size <= 0) throw new Error("Invalid encrypted canvas chunk length");
    const input = reader.take(size);
    const key = keyStream(size);
    const output = Buffer.alloc(size);
    for (let i = 0; i < size; i++) output[i] = input[i] ^ key[i];
    chunks.push(output);
  }
  return Buffer.concat(chunks);
}
/** Bound the decompressed allocation before computing storage dimensions. */
function validateDimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_CANVAS_DIMENSION ||
    height > MAX_CANVAS_DIMENSION ||
    width * height > MAX_CANVAS_PIXELS
  ) {
    throw new Error(`Unsafe Canvas dimensions ${width}x${height}`);
  }
}
/** Validate the pixel allocation and original separate format/scale fields. */
function canvasLayout(canvas) {
  const { width, height, format, scale } = canvas;
  validateDimensions(width, height);
  if (![1, 2, 513, 1026].includes(format)) {
    throw new Error(`Unsupported Canvas pixel format ${format}`);
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 16) {
    throw new Error(`Unsupported Canvas scale ${scale}`);
  }
  if (!Buffer.isBuffer(canvas.data)) throw new Error("Missing Canvas data");
  const factor = 2 ** scale;
  const storedWidth = Math.ceil(width / factor);
  const storedHeight = Math.ceil(height / factor);
  const pixelBytes = format === 2 ? 4 : 2;
  const expected =
    format === 1026
      ? Math.ceil(storedWidth / 4) * Math.ceil(storedHeight / 4) * 16
      : storedWidth * storedHeight * pixelBytes;
  return {
    width,
    height,
    format,
    scale,
    factor,
    storedWidth,
    storedHeight,
    pixelBytes,
    expected,
  };
}
/** Inflate exactly the validated stored-pixel size, retaining sync-flush support. */
function inflatePixels(payload, expected) {
  const compressed = compressedBytes(payload);
  // Original streams finish a sync-flushed segment, not necessarily a zlib end trailer.
  const syncFlushed =
    compressed.length >= 4 &&
    compressed.subarray(-4).equals(SYNC_FLUSH_TRAILER);
  const raw = inflateSync(compressed, {
    maxOutputLength: expected,
    finishFlush: syncFlushed ? constants.Z_SYNC_FLUSH : constants.Z_FINISH,
  });
  if (raw.length !== expected) {
    throw new Error(`Canvas inflated length ${raw.length} != ${expected}`);
  }
  return raw;
}
/** Expand one stored pixel, clipping scaled and DXT edge blocks to the canvas. */
function writePixel(output, sx, sy, color) {
  const { width, height, factor, rgba } = output;
  const endY = Math.min(height, (sy + 1) * factor);
  const endX = Math.min(width, (sx + 1) * factor);
  for (let y = sy * factor; y < endY; y++) {
    for (let x = sx * factor; x < endX; x++) {
      const offset = (y * width + x) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
}
/** Convert the recovered packed formats; RGB565 uses original asymmetric red expansion. */
function packedColor(raw, source, format, color) {
  if (format === 2) {
    color[0] = raw[source + 2];
    color[1] = raw[source + 1];
    color[2] = raw[source];
    color[3] = raw[source + 3];
    return;
  }
  const pixel = raw.readUInt16LE(source);
  if (format === 1) {
    color[0] = ((pixel >>> 8) & 15) * 17;
    color[1] = ((pixel >>> 4) & 15) * 17;
    color[2] = (pixel & 15) * 17;
    color[3] = (pixel >>> 12) * 17;
    return;
  }
  const green = (pixel >>> 5) & 63;
  const blue = pixel & 31;
  color[0] = (pixel >>> 11) << 3;
  color[1] = (green << 2) | (green >>> 4);
  color[2] = (blue << 3) | (blue >>> 2);
  color[3] = 255;
}
/** Decode stored pixels once; scaling only repeats their unmodified RGBA values. */
function decodePacked(raw, output) {
  if (output.factor === 1) {
    decodeUnscaled(raw, output.rgba, output.format);
    return;
  }
  const color = new Uint8Array(4);
  for (let y = 0; y < output.storedHeight; y++) {
    for (let x = 0; x < output.storedWidth; x++) {
      const source = (y * output.storedWidth + x) * output.pixelBytes;
      packedColor(raw, source, output.format, color);
      writePixel(output, x, y, color);
    }
  }
}
/** The usual unscaled canvas needs no coordinate expansion or per-pixel scratch array. */
function decodeUnscaled(raw, rgba, format) {
  if (format === 2) {
    const length = raw.length;
    for (let offset = 0; offset < length; offset += 4) {
      rgba[offset] = raw[offset + 2];
      rgba[offset + 1] = raw[offset + 1];
      rgba[offset + 2] = raw[offset];
      rgba[offset + 3] = raw[offset + 3];
    }
    return;
  }
  if (format === 1) {
    decode4444(raw, rgba);
    return;
  }
  decode565(raw, rgba);
}

/** Validated inflate lengths make each two-byte source read and RGBA write complete. */
function decode4444(raw, rgba) {
  const length = raw.length;
  for (let source = 0; source < length; source += 2) {
    const low = raw[source],
      high = raw[source + 1],
      target = source * 2;
    rgba[target] = (high & 15) * 17;
    rgba[target + 1] = (low >>> 4) * 17;
    rgba[target + 2] = (low & 15) * 17;
    rgba[target + 3] = (high >>> 4) * 17;
  }
}

/** Preserve the original RGB565 asymmetric red expansion from packedColor. */
function decode565(raw, rgba) {
  const length = raw.length;
  for (let source = 0; source < length; source += 2) {
    const pixel = raw[source] | (raw[source + 1] << 8),
      target = source * 2;
    const green = (pixel >>> 5) & 63,
      blue = pixel & 31;
    rgba[target] = (pixel >>> 11) << 3;
    rgba[target + 1] = (green << 2) | (green >>> 4);
    rgba[target + 2] = (blue << 3) | (blue >>> 2);
    rgba[target + 3] = 255;
  }
}
/** DXT3 always has four colors, irrespective of endpoint ordering. */
function dxtPalette(raw, block, colors) {
  for (let c = 0; c < 2; c++) {
    const pixel = raw.readUInt16LE(block + 8 + c * 2);
    colors[c * 3] = Math.round(((pixel >>> 11) * 255) / 31);
    colors[c * 3 + 1] = Math.round((((pixel >>> 5) & 63) * 255) / 63);
    colors[c * 3 + 2] = Math.round(((pixel & 31) * 255) / 31);
  }
  for (let c = 0; c < 3; c++) {
    colors[6 + c] = Math.floor((2 * colors[c] + colors[3 + c]) / 3);
    colors[9 + c] = Math.floor((colors[c] + 2 * colors[3 + c]) / 3);
  }
}
/** Decode one 16-byte block using scratch arrays owned by this decode operation. */
function decodeDxtBlock(raw, output, blockIndex, scratch) {
  const block = blockIndex * 16;
  const blocksX = Math.ceil(output.storedWidth / 4);
  const bx = blockIndex % blocksX;
  const by = Math.floor(blockIndex / blocksX);
  dxtPalette(raw, block, scratch.colors);
  const indices = raw.readUInt32LE(block + 12);
  for (let p = 0; p < 16; p++) {
    const colorIndex = ((indices >>> (p * 2)) & 3) * 3;
    scratch.pixel[0] = scratch.colors[colorIndex];
    scratch.pixel[1] = scratch.colors[colorIndex + 1];
    scratch.pixel[2] = scratch.colors[colorIndex + 2];
    scratch.pixel[3] =
      ((raw[block + Math.floor(p / 2)] >>> ((p & 1) * 4)) & 15) * 17;
    writePixel(
      output,
      bx * 4 + (p % 4),
      by * 4 + Math.floor(p / 4),
      scratch.pixel,
    );
  }
}
/** Gr2D_DX8.dll FUN_50404869 maps 0x402 to D3DFMT_DXT3. */
function decodeDxt(raw, output) {
  const scratch = { colors: new Uint8Array(12), pixel: new Uint8Array(4) };
  const count =
    Math.ceil(output.storedWidth / 4) * Math.ceil(output.storedHeight / 4);
  for (let block = 0; block < count; block++) {
    decodeDxtBlock(raw, output, block, scratch);
  }
}
/** Decode original Canvas pixels to straight-alpha RGBA.
 * @param {import('./image.js').WzNode} canvas
 * @returns {{width:number,height:number,rgba:Buffer,format:number,scale:number}}
 */
/** @param {object} canvas  @param {{ boostAlpha?: boolean }} [options] */
export function decodeCanvas(canvas, options) {
  const output = canvasLayout(canvas);
  const raw = inflatePixels(canvas.data, output.expected);
  output.rgba = Buffer.alloc(output.width * output.height * 4);
  if (output.format === 1026) decodeDxt(raw, output);
  else decodePacked(raw, output);

  // Afterimage Canvas pixels have low-alpha semi-transparent areas that define
  // the silhouette — original MapleStory draws them with a full opacity pass
  // and uses only Canvas a0/a1 for time-based decay. When boostAlpha is true,
  // every pixel with alpha > 0 is set to alpha = 255, preserving the shape
  // but making every drawn pixel fully opaque.
  if (options?.boostAlpha) {
    const rgba = output.rgba;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] > 0) rgba[i] = 255;
    }
  }

  const { width, height, rgba, format, scale } = output;
  return { width, height, rgba, format, scale };
}
