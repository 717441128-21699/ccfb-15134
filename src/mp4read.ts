// M4B 解析器(校验页用):重新解析成品文件,提取
//  - Nero chpl 章节
//  - QuickTime 文本章节轨(标题 + 时间点)
//  - ilst 元数据 / covr 封面
//  - 音频轨时长、采样率、帧数
// 通过 ReadFn 按需读取,不必把整个文件读进内存。

export type ReadFn = (offset: number, length: number) => Promise<Uint8Array>;

export interface M4bChapterInfo {
  title: string;
  startMs: number;
  durationMs: number;
}

export interface M4bInfo {
  majorBrand: string;
  fileSize: number;
  durationMs: number; // mvhd
  audio: {
    sampleRate: number;
    durationMs: number; // mdhd 精确时长
    frameCount: number;
    totalSamples: number;
    audioBytes: number; // stsz 求和
  } | null;
  chplChapters: M4bChapterInfo[];
  qtChapters: M4bChapterInfo[];
  tags: Record<string, string>;
  coverBytes: number;
}

interface Box {
  type: string;
  start: number;
  size: number;
  header: number;
}

function ascii(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

// 在内存缓冲上遍历子 box
class Cursor {
  dv: DataView;
  constructor(public buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  }
  u32(o: number) { return this.dv.getUint32(o); }
  boxes(from: number, to: number): Box[] {
    const out: Box[] = [];
    let p = from;
    while (p + 8 <= to) {
      const size32 = this.u32(p);
      const type = ascii(this.buf, p + 4, 4);
      let size: number, header: number;
      if (size32 === 1) {
        size = Number(this.dv.getBigUint64(p + 8));
        header = 16;
      } else if (size32 === 0) {
        size = to - p;
        header = 8;
      } else {
        size = size32;
        header = 8;
      }
      if (size < header || p + size > to) break;
      out.push({ type, start: p, size, header });
      p += size;
    }
    return out;
  }
  find(from: number, to: number, type: string): Box | null {
    for (const b of this.boxes(from, to)) if (b.type === type) return b;
    return null;
  }
}

interface StblData {
  stts: Array<[number, number]>;
  stsc: Array<[number, number, number]>;
  stszCount: number;
  stszSizes: Uint32Array | null; // 仅在需要时加载
  chunkOffsets: number[];
}

function parseStbl(c: Cursor, from: number, to: number, loadSizes: boolean): StblData {
  const r: StblData = { stts: [], stsc: [], stszCount: 0, stszSizes: null, chunkOffsets: [] };
  for (const b of c.boxes(from, to)) {
    const d = b.start + b.header + 4; // 跳过 fullbox 头
    if (b.type === 'stts') {
      const n = c.u32(d);
      for (let i = 0; i < n; i++) r.stts.push([c.u32(d + 4 + i * 8), c.u32(d + 8 + i * 8)]);
    } else if (b.type === 'stsc') {
      const n = c.u32(d);
      for (let i = 0; i < n; i++) r.stsc.push([c.u32(d + 4 + i * 12), c.u32(d + 8 + i * 12), c.u32(d + 12 + i * 12)]);
    } else if (b.type === 'stsz') {
      r.stszCount = c.u32(d + 4);
      if (loadSizes) {
        const sizes = new Uint32Array(r.stszCount);
        for (let i = 0; i < r.stszCount; i++) sizes[i] = c.u32(d + 8 + i * 4);
        r.stszSizes = sizes;
      }
    } else if (b.type === 'stco' || b.type === 'co64') {
      const n = c.u32(d);
      const co64 = b.type === 'co64';
      for (let i = 0; i < n; i++) {
        r.chunkOffsets.push(co64 ? Number(c.dv.getBigUint64(d + 4 + i * 8)) : c.u32(d + 4 + i * 4));
      }
    }
  }
  return r;
}

// 按 stsc/stco/stsz 计算每个样本的文件偏移(仅用于小样本量的文本轨)
function sampleOffsets(stsc: Array<[number, number, number]>, chunkOffsets: number[], sizes: Uint32Array): number[] {
  const offsets = new Array<number>(sizes.length);
  let si = 0;
  let scIdx = 0;
  for (let ci = 0; ci < chunkOffsets.length; ci++) {
    const chunkNo = ci + 1;
    while (scIdx + 1 < stsc.length && stsc[scIdx + 1][0] <= chunkNo) scIdx++;
    const perChunk = stsc[scIdx][1];
    let off = chunkOffsets[ci];
    for (let k = 0; k < perChunk && si < sizes.length; k++) {
      offsets[si] = off;
      off += sizes[si];
      si++;
    }
  }
  return offsets;
}

export async function parseM4b(read: ReadFn, fileSize: number): Promise<M4bInfo> {
  // 顶层 box 扫描
  let majorBrand = '';
  let moovOff = -1, moovSize = 0;
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const h = await read(pos, Math.min(16, fileSize - pos));
    const dv = new DataView(h.buffer, h.byteOffset, h.length);
    const size32 = dv.getUint32(0);
    const type = ascii(h, 4, 4);
    let size: number;
    if (size32 === 1) size = Number(dv.getBigUint64(8));
    else if (size32 === 0) size = fileSize - pos;
    else size = size32;
    if (type === 'ftyp') majorBrand = ascii(h, 8, 4);
    if (type === 'moov') { moovOff = pos; moovSize = size; break; }
    if (size <= 0) break;
    pos += size;
  }
  if (moovOff < 0) throw new Error('未找到 moov box,不是有效的 M4B/MP4 文件');

  const moovBuf = await read(moovOff, moovSize);
  const c = new Cursor(moovBuf);
  const moovDataStart = c.u32(0) === 1 ? 16 : 8; // size==1 时有 64 位 largesize

  const info: M4bInfo = {
    majorBrand,
    fileSize,
    durationMs: 0,
    audio: null,
    chplChapters: [],
    qtChapters: [],
    tags: {},
    coverBytes: 0,
  };

  const moovBody = c.boxes(moovDataStart, moovSize);
  const mvhd = moovBody.find((b) => b.type === 'mvhd');
  if (mvhd) {
    const d = mvhd.start + mvhd.header + 4;
    const ver = moovBuf[mvhd.start + mvhd.header];
    const timescale = c.u32(ver === 1 ? d + 16 : d + 8);
    const duration = ver === 1 ? Number(c.dv.getBigUint64(d + 20)) : c.u32(d + 12);
    info.durationMs = timescale ? (duration * 1000) / timescale : 0;
  }

  // 遍历 trak
  for (const trak of moovBody.filter((b) => b.type === 'trak')) {
    const mdia = c.find(trak.start + trak.header, trak.start + trak.size, 'mdia');
    if (!mdia) continue;
    const mdhd = c.find(mdia.start + mdia.header, mdia.start + mdia.size, 'mdhd');
    const hdlr = c.find(mdia.start + mdia.header, mdia.start + mdia.size, 'hdlr');
    if (!mdhd || !hdlr) continue;
    const handler = ascii(moovBuf, hdlr.start + hdlr.header + 8, 4);
    const mdVer = moovBuf[mdhd.start + mdhd.header];
    const md = mdhd.start + mdhd.header + 4;
    const timescale = c.u32(mdVer === 1 ? md + 16 : md + 8);
    const duration = mdVer === 1 ? Number(c.dv.getBigUint64(md + 20)) : c.u32(md + 12);

    const minf = c.find(mdia.start + mdia.header, mdia.start + mdia.size, 'minf');
    if (!minf) continue;
    const stbl = c.find(minf.start + minf.header, minf.start + minf.size, 'stbl');
    if (!stbl) continue;

    if (handler === 'soun') {
      const st = parseStbl(c, stbl.start + stbl.header, stbl.start + stbl.size, true);
      let totalSamples = 0;
      for (const [count, delta] of st.stts) totalSamples += count * delta;
      let audioBytes = 0;
      if (st.stszSizes) for (let i = 0; i < st.stszSizes.length; i++) audioBytes += st.stszSizes[i];
      info.audio = {
        sampleRate: timescale,
        durationMs: timescale ? (duration * 1000) / timescale : 0,
        frameCount: st.stszCount,
        totalSamples,
        audioBytes,
      };
    } else if (handler === 'text') {
      const st = parseStbl(c, stbl.start + stbl.header, stbl.start + stbl.size, true);
      if (!st.stszSizes) continue;
      // 展开 stts(可能多条目合并)
      const deltas: number[] = [];
      for (const [count, delta] of st.stts) for (let k = 0; k < count; k++) deltas.push(delta);
      const offsets = sampleOffsets(st.stsc, st.chunkOffsets, st.stszSizes);
      let startUnits = 0;
      for (let i = 0; i < st.stszSizes.length; i++) {
        const sample = await read(offsets[i], st.stszSizes[i]);
        const len = (sample[0] << 8) | sample[1];
        const title = new TextDecoder().decode(sample.subarray(2, 2 + len));
        const durUnits = deltas[i] ?? 0;
        info.qtChapters.push({
          title,
          startMs: timescale ? (startUnits * 1000) / timescale : 0,
          durationMs: timescale ? (durUnits * 1000) / timescale : 0,
        });
        startUnits += durUnits;
      }
    }
  }

  // udta:chpl + meta/ilst
  const udta = moovBody.find((b) => b.type === 'udta');
  if (udta) {
    for (const b of c.boxes(udta.start + udta.header, udta.start + udta.size)) {
      if (b.type === 'chpl') {
        let p = b.start + b.header;
        p += 4; // version+flags
        p += 4; // reserved
        const count = moovBuf[p++];
        for (let i = 0; i < count; i++) {
          const t100ns = Number(c.dv.getBigUint64(p));
          p += 8;
          const len = moovBuf[p++];
          const title = new TextDecoder().decode(moovBuf.subarray(p, p + len));
          p += len;
          info.chplChapters.push({ title, startMs: t100ns / 1e4, durationMs: 0 });
        }
      } else if (b.type === 'meta') {
        const metaBody = c.boxes(b.start + b.header + 4, b.start + b.size);
        const ilst = metaBody.find((x) => x.type === 'ilst');
        if (ilst) {
          for (const item of c.boxes(ilst.start + ilst.header, ilst.start + ilst.size)) {
            const data = c.find(item.start + item.header, item.start + item.size, 'data');
            if (!data) continue;
            const d = data.start + data.header;
            const dataType = c.u32(d);
            const payload = moovBuf.subarray(d + 8, data.start + data.size);
            let key = item.type;
            if (moovBuf[item.start + 4] === 0xa9) key = '©' + ascii(moovBuf, item.start + 5, 3);
            if (dataType === 1) info.tags[key] = new TextDecoder().decode(payload);
            else if (item.type === 'covr') info.coverBytes = payload.length;
          }
        }
      }
    }
  }

  return info;
}
