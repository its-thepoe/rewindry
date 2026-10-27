import { crc32, deflateSync, inflateSync } from 'node:zlib';

// Just enough PNG for Chromium screenshots: 8-bit RGB/RGBA, non-interlaced, decoded to RGBA.
export type RgbaImage = { width: number; height: number; data: Buffer };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 64 * 1024 * 1024;

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

export function decodePng(bytes: Buffer): RgbaImage {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG image');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error('Truncated PNG chunk');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('Unsupported PNG format');
      channels = colorType === 6 ? 4 : 3;
      if (!width || !height || width * height > MAX_PIXELS) throw new Error('Unsupported PNG size');
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!channels) throw new Error('PNG header missing');
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('Truncated PNG data');
  const data = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      if (filter === 1) line[x] = (line[x]! + left) & 0xff;
      else if (filter === 2) line[x] = (line[x]! + up) & 0xff;
      else if (filter === 3) line[x] = (line[x]! + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) line[x] = (line[x]! + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error('Invalid PNG filter');
    }
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      line.copy(data, target, x * channels, x * channels + 3);
      data[target + 3] = channels === 4 ? line[x * channels + 3]! : 255;
    }
    previous = line;
  }
  return { width, height, data };
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([header, data, crc]);
}

// Deterministic: identical pixels always encode to identical bytes, so digests deduplicate crops.
export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export type PixelRect = { x: number; y: number; width: number; height: number };

// Clamps to the image; returns null when nothing of the rectangle is inside it.
export function cropImage(image: RgbaImage, rect: PixelRect): RgbaImage | null {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(image.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) return null;
  const width = right - left;
  const height = bottom - top;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    image.data.copy(data, y * width * 4, ((top + y) * image.width + left) * 4, ((top + y) * image.width + right) * 4);
  }
  return { width, height, data };
}
