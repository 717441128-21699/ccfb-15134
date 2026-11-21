// ID3v2.4 写入器 + ID3v2.3/2.4 解析器(校验用)。
// 写出:文本帧(UTF-8)、COMM、APIC(封面)、CHAP(章节)、CTOC(目录)。
// CHAP 时间单位为毫秒(u32),由帧级采样数换算,误差 ≤0.5ms。

const te = new TextEncoder();

function syncsafe(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function frame(id: string, body: number[]): number[] {
  const idBytes = [id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3)];
  return [...idBytes, ...syncsafe(body.length), 0, 0, ...body];
}

function textFrame(id: string, text: string): number[] {
  return frame(id, [0x03, ...te.encode(text)]); // 0x03 = UTF-8
}

export interface Id3Chapter {
  id: string; // 元素 ID,如 "ch0"
  startMs: number;
  endMs: number;
  title: string;
}

export interface Id3TagInput {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  comment: string;
  cover?: { data: Uint8Array; mime: string } | null;
  chapters: Id3Chapter[];
}

export function writeId3v24(input: Id3TagInput): Uint8Array<ArrayBuffer> {
  const frames: number[] = [];
  if (input.title) frames.push(...textFrame('TIT2', input.title));
  if (input.artist) frames.push(...textFrame('TPE1', input.artist));
  if (input.album) frames.push(...textFrame('TALB', input.album));
  if (input.year) frames.push(...textFrame('TDRC', input.year));
  if (input.genre) frames.push(...textFrame('TCON', input.genre));
  if (input.comment) {
    frames.push(...frame('COMM', [0x03, 0x65, 0x6e, 0x67, 0x00, ...te.encode(input.comment)])); // 'eng'
  }
  if (input.cover && input.cover.data.length > 0) {
    frames.push(
      ...frame('APIC', [
        0x03,
        ...te.encode(input.cover.mime),
        0x00,
        0x03, // 图片类型:封面(正面)
        0x00, // 空描述
        ...input.cover.data,
      ])
    );
  }
  const chapIds: string[] = [];
  input.chapters.forEach((c, i) => {
    const elId = c.id || `ch${i}`;
    chapIds.push(elId);
    const tit2 = textFrame('TIT2', c.title);
    frames.push(
      ...frame('CHAP', [
        ...te.encode(elId),
        0x00,
        ...u32be(c.startMs >>> 0),
        ...u32be(c.endMs >>> 0),
        0xff, 0xff, 0xff, 0xff, // 起始字节偏移:不用
        0xff, 0xff, 0xff, 0xff, // 结束字节偏移:不用
        ...tit2,
      ])
    );
  });
  if (chapIds.length > 0) {
    // CTOC 子元素计数为 u8,超过 255 章时只列前 255 个(CHAP 帧本身不受限)
    const listed = chapIds.slice(0, 255);
    const body: number[] = [...te.encode('toc'), 0x00, 0x03, listed.length]; // 0x03 = 顶层 + 有序
    for (const id of listed) body.push(...te.encode(id), 0x00);
    body.push(...textFrame('TIT2', input.title || '章节目录'));
    frames.push(...frame('CTOC', body));
  }
  const tag = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, ...syncsafe(frames.length), ...frames];
  return new Uint8Array(tag);
}

// ---------------- 解析(校验页用) ----------------

export interface ParsedChapter {
  id: string;
  startMs: number;
  endMs: number;
  title: string;
}

export interface ParsedId3 {
  version: string;
  tagSize: number; // 含 10 字节头
  texts: Record<string, string>; // TIT2/TPE1/TALB/TDRC/TCON 等
  comment: string;
  cover: { mime: string; bytes: number } | null;
  chapters: ParsedChapter[];
  tocChildIds: string[];
}

function decodeText(buf: Uint8Array, enc: number): string {
  if (enc === 0x03) return new TextDecoder('utf-8').decode(buf);
  if (enc === 0x00) {
    let s = '';
    for (const b of buf) s += String.fromCharCode(b);
    return s;
  }
  // 0x01: UTF-16 带 BOM;0x02: UTF-16BE
  if (enc === 0x02) {
    const swapped = new Uint8Array(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  let b = buf;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) b = b.subarray(2);
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const swapped = new Uint8Array(b.length - 2);
    for (let i = 2; i + 1 < b.length; i += 2) {
      swapped[i - 2] = b[i + 1];
      swapped[i - 1] = b[i];
    }
    b = swapped.subarray(0, b.length - 2 - ((b.length - 2) % 2));
  }
  return new TextDecoder('utf-16le').decode(b);
}

function readCString(buf: Uint8Array, from: number): { str: string; next: number } {
  let end = from;
  while (end < buf.length && buf[end] !== 0) end++;
  let s = '';
  for (let i = from; i < end; i++) s += String.fromCharCode(buf[i]);
  return { str: s, next: end + 1 };
}

export function parseId3(buf: Uint8Array): ParsedId3 | null {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
  const major = buf[3];
  const tagBodySize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const result: ParsedId3 = {
    version: `2.${major}.${buf[4]}`,
    tagSize: 10 + tagBodySize,
    texts: {},
    comment: '',
    cover: null,
    chapters: [],
    tocChildIds: [],
  };
  // 解析一个帧区间(CHAP/CTOC 内嵌子帧复用),b 为当前区间所属的缓冲
  const parseFrames = (b: Uint8Array, from: number, to: number, into: ParsedId3, chapterOut?: ParsedChapter) => {
    const u32of = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    let p = from;
    while (p + 10 <= to) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      if (b[p] === 0) break;
      const size = major >= 4
        ? ((b[p + 4] & 0x7f) << 21) | ((b[p + 5] & 0x7f) << 14) | ((b[p + 6] & 0x7f) << 7) | (b[p + 7] & 0x7f)
        : u32of(p + 4);
      if (size < 0 || p + 10 + size > to) break;
      const body = b.subarray(p + 10, p + 10 + size);
      if (id[0] === 'T' && id !== 'TXXX' && body.length > 0) {
        const text = decodeText(body.subarray(1), body[0]).replace(/\0+$/, '');
        if (chapterOut && id === 'TIT2') chapterOut.title = text;
        else into.texts[id] = text;
      } else if (id === 'COMM' && body.length > 4) {
        const { next } = readCString(body, 4);
        into.comment = decodeText(body.subarray(next), body[0]);
      } else if (id === 'APIC' && body.length > 2) {
        const { str: mime, next } = readCString(body, 1);
        let d = next + 1; // 跳过图片类型
        const descEnd = readCString(body, d).next;
        into.cover = { mime, bytes: body.length - descEnd };
      } else if (id === 'CHAP') {
        const { str: elId, next } = readCString(body, 0);
        if (next + 16 <= body.length) {
          const dv = new DataView(body.buffer, body.byteOffset + next);
          const ch: ParsedChapter = {
            id: elId,
            startMs: dv.getUint32(0),
            endMs: dv.getUint32(4),
            title: '',
          };
          parseFrames(body, next + 16, body.length, into, ch);
          into.chapters.push(ch);
        }
      } else if (id === 'CTOC') {
        const { next } = readCString(body, 0);
        if (next + 2 <= body.length) {
          const count = body[next + 1];
          let q = next + 2;
          for (let i = 0; i < count && q < body.length; i++) {
            const c = readCString(body, q);
            into.tocChildIds.push(c.str);
            q = c.next;
          }
        }
      }
      p += 10 + size;
    }
  };

  parseFrames(buf, 10, 10 + tagBodySize, result);
  return result;
}
