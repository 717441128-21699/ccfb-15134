// M4B(ISO-BMFF)封装器:把 MP3 帧流直接装进 MP4 容器,不做转码。
// 章节双写:
//   1. Nero chpl(moov/udta/chpl),时间单位 100ns;
//   2. QuickTime 文本章节轨(handler 'text',音频轨 tref/chap 指向它),
//      时间轴与音频轨共用采样率时基,章节点落在精确的采样边界上。
// 元数据走 moov/udta/meta/ilst(iTunes 风格,含 covr 封面)。

export interface M4bMeta {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  comment: string;
  cover?: { data: Uint8Array; mime: string } | null;
}

export interface M4bChapterIn {
  title: string;
  startSamples: number; // 在整书中的起始采样(音频时基)
  durationSamples: number;
}

export interface M4bInput {
  sampleRate: number;
  channels: number;
  samplesPerFrame: number; // 1152 或 576
  mpegVersion: number; // 1 / 2 / 2.5
  frameSizes: Uint32Array; // 全书所有帧的字节数
  audioParts: Blob[]; // 各文件的帧数据切片,顺序拼接
  chapters: M4bChapterIn[];
  meta: M4bMeta;
}

const FRAMES_PER_CHUNK = 4096; // 每 chunk 帧数:128kbps 下约 1.7MB,30 小时约千个 chunk

class W {
  buf: Uint8Array<ArrayBuffer>;
  dv: DataView;
  len = 0;
  constructor(cap = 1 << 20) {
    this.buf = new Uint8Array(cap);
    this.dv = new DataView(this.buf.buffer);
  }
  private need(n: number) {
    if (this.len + n <= this.buf.length) return;
    let c = this.buf.length * 2;
    while (c < this.len + n) c *= 2;
    const nb = new Uint8Array(c);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number) { this.need(1); this.buf[this.len++] = v & 0xff; }
  u16(v: number) { this.need(2); this.dv.setUint16(this.len, v); this.len += 2; }
  u24(v: number) { this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); }
  u32(v: number) { this.need(4); this.dv.setUint32(this.len, v >>> 0); this.len += 4; }
  u64(v: number | bigint) { this.need(8); this.dv.setBigUint64(this.len, BigInt(v)); this.len += 8; }
  fourcc(s: string) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  bytes(a: Uint8Array) { this.need(a.length); this.buf.set(a, this.len); this.len += a.length; }
  str(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  boxStart(type: string): number { const p = this.len; this.u32(0); this.fourcc(type); return p; }
  boxEnd(p: number) { this.dv.setUint32(p, this.len - p); }
  fullbox(type: string, version: number, flags: number): number {
    const p = this.boxStart(type);
    this.u8(version);
    this.u24(flags);
    return p;
  }
  out(): Uint8Array<ArrayBuffer> { return this.buf.slice(0, this.len); }
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function writeMatrix(w: W) { for (const m of MATRIX) w.u32(m); }

function writeFtyp(): Uint8Array {
  const w = new W(64);
  const p = w.boxStart('ftyp');
  w.fourcc('M4B ');
  w.u32(0);
  w.fourcc('M4B '); w.fourcc('M4A '); w.fourcc('mp42'); w.fourcc('isom');
  w.boxEnd(p);
  return w.out();
}

function writeMvhd(w: W, durationMs: number) {
  const p = w.fullbox('mvhd', 0, 0);
  w.u32(0); w.u32(0); // 创建/修改时间
  w.u32(1000); // 电影时基
  w.u32(durationMs);
  w.u32(0x00010000); // rate
  w.u16(0x0100); // volume
  w.u16(0);
  w.u32(0); w.u32(0);
  writeMatrix(w);
  for (let i = 0; i < 6; i++) w.u32(0);
  w.u32(3); // next_track_id
  w.boxEnd(p);
}

function writeTkhd(w: W, trackId: number, durationMs: number, isAudio: boolean) {
  const p = w.fullbox('tkhd', 0, 0x7);
  w.u32(0); w.u32(0);
  w.u32(trackId);
  w.u32(0);
  w.u32(durationMs);
  w.u32(0); w.u32(0);
  w.u16(0); // layer
  w.u16(0); // alternate group
  w.u16(isAudio ? 0x0100 : 0);
  w.u16(0);
  writeMatrix(w);
  w.u32(0); w.u32(0); // width/height
  w.boxEnd(p);
}

function writeMdhd(w: W, timescale: number, duration: number) {
  if (duration > 0xffffffff) {
    const p = w.fullbox('mdhd', 1, 0);
    w.u64(0); w.u64(0);
    w.u32(timescale);
    w.u64(duration);
    w.u16(0x55c4); // 'und'
    w.u16(0);
    w.boxEnd(p);
  } else {
    const p = w.fullbox('mdhd', 0, 0);
    w.u32(0); w.u32(0);
    w.u32(timescale);
    w.u32(duration);
    w.u16(0x55c4);
    w.u16(0);
    w.boxEnd(p);
  }
}

function writeHdlr(w: W, handler: string, name: string) {
  const p = w.fullbox('hdlr', 0, 0);
  w.u32(0);
  w.fourcc(handler);
  w.u32(0); w.u32(0); w.u32(0);
  for (let i = 0; i < name.length; i++) w.u8(name.charCodeAt(i));
  w.u8(0);
  w.boxEnd(p);
}

function writeDinf(w: W) {
  const p = w.boxStart('dinf');
  const d = w.fullbox('dref', 0, 0);
  w.u32(1);
  const u = w.fullbox('url ', 0, 1); // 自包含
  w.boxEnd(u);
  w.boxEnd(d);
  w.boxEnd(p);
}

function writeEsds(w: W, mpegVersion: number, maxFrameSize: number, avgBitrate: number) {
  const p = w.fullbox('esds', 0, 0);
  const oti = mpegVersion === 1 ? 0x6b : 0x69; // 11172-3 / 13818-3
  w.u8(0x03); w.u8(19); // ES_Descriptor,长度 19
  w.u16(1); w.u8(0); // ES_ID, flags
  w.u8(0x04); w.u8(13); // DecoderConfigDescriptor,长度 13
  w.u8(oti);
  w.u8(0x15); // streamType=音频(5<<2)
  w.u24(Math.max(6144, maxFrameSize * 2)); // bufferSizeDB
  w.u32(avgBitrate); // maxBitrate(VBR 未知,填平均)
  w.u32(avgBitrate);
  w.u8(0x06); w.u8(1); w.u8(0x02); // SLConfigDescriptor, predefined=2
  w.boxEnd(p);
}

function writeMp4a(w: W, channels: number, sampleRate: number, mpegVersion: number, maxFrameSize: number, avgBitrate: number) {
  const p = w.boxStart('mp4a');
  for (let i = 0; i < 6; i++) w.u8(0);
  w.u16(1); // data_reference_index
  w.u16(0); w.u16(0); w.u32(0); // version/revision/vendor
  w.u16(channels);
  w.u16(16); // sampleSize
  w.u16(0); w.u16(0);
  w.u32(sampleRate << 16);
  writeEsds(w, mpegVersion, maxFrameSize, avgBitrate);
  w.boxEnd(p);
}

function writeTextSampleEntry(w: W) {
  const p = w.boxStart('text');
  for (let i = 0; i < 6; i++) w.u8(0);
  w.u16(1);
  w.u32(0x01); // displayFlags
  w.u32(0); // justification
  w.u16(0); w.u16(0); w.u16(0); // 背景色
  w.u16(0); w.u16(0); w.u16(0); w.u16(0); // defaultTextBox
  w.u16(0); // reserved
  w.u16(0); // fontNumber
  w.u16(0); // fontFace
  w.u32(0); // 前景色
  w.u8(0); // fontName(空 Pascal 字符串)
  w.boxEnd(p);
}

function writeStts(w: W, entries: Array<[number, number]>) {
  const p = w.fullbox('stts', 0, 0);
  w.u32(entries.length);
  for (const [count, delta] of entries) { w.u32(count); w.u32(delta); }
  w.boxEnd(p);
}

function writeStsc(w: W, entries: Array<[number, number, number]>) {
  const p = w.fullbox('stsc', 0, 0);
  w.u32(entries.length);
  for (const [first, per, desc] of entries) { w.u32(first); w.u32(per); w.u32(desc); }
  w.boxEnd(p);
}

function writeStsz(w: W, sizes: Uint32Array | number[]) {
  const p = w.fullbox('stsz', 0, 0);
  w.u32(0); // 非定长
  w.u32(sizes.length);
  for (let i = 0; i < sizes.length; i++) w.u32(sizes[i]);
  w.boxEnd(p);
}

function writeStco(w: W, offsets: number[], co64: boolean) {
  const p = w.fullbox(co64 ? 'co64' : 'stco', 0, 0);
  w.u32(offsets.length);
  for (const o of offsets) { if (co64) w.u64(o); else w.u32(o); }
  w.boxEnd(p);
}

function writeIlstItem(w: W, key: string, text: string) {
  const p = w.boxStart(key);
  const d = w.boxStart('data');
  w.u32(1); // UTF-8 文本
  w.u32(0); // locale
  w.bytes(new TextEncoder().encode(text));
  w.boxEnd(d);
  w.boxEnd(p);
}

export function buildM4b(inp: M4bInput): Blob {
  const sr = inp.sampleRate;
  const frameCount = inp.frameSizes.length;
  const totalSamples = frameCount * inp.samplesPerFrame;
  const durationMs = Math.round((totalSamples * 1000) / sr);

  // 章节文本样本:u16 长度 + UTF-8
  const te = new TextEncoder();
  const textSizes: number[] = [];
  let textBytesTotal = 0;
  const textParts: Uint8Array[] = [];
  for (const c of inp.chapters) {
    const t = te.encode(c.title);
    const s = new Uint8Array(2 + t.length);
    s[0] = t.length >>> 8;
    s[1] = t.length & 0xff;
    s.set(t, 2);
    textParts.push(s);
    textSizes.push(s.length);
    textBytesTotal += s.length;
  }
  const textChunk = new Uint8Array(textBytesTotal);
  { let o = 0; for (const p of textParts) { textChunk.set(p, o); o += p.length; } }

  // 音频总字节数 / 最大帧
  let audioBytes = 0;
  let maxFrameSize = 0;
  for (let i = 0; i < frameCount; i++) {
    audioBytes += inp.frameSizes[i];
    if (inp.frameSizes[i] > maxFrameSize) maxFrameSize = inp.frameSizes[i];
  }
  const avgBitrate = Math.round((audioBytes * 8) / (totalSamples / sr));

  const ftyp = writeFtyp();
  const mdatPayload = audioBytes + textBytesTotal;
  const mdatHeaderSize = mdatPayload + 8 >= 0x100000000 ? 16 : 8;
  const base = ftyp.length + mdatHeaderSize;

  // 音频 chunk 划分与偏移
  const nChunks = Math.max(1, Math.ceil(frameCount / FRAMES_PER_CHUNK));
  const chunkOffsets: number[] = new Array(nChunks);
  let off = base;
  let fi = 0;
  for (let c = 0; c < nChunks; c++) {
    chunkOffsets[c] = off;
    const n = Math.min(FRAMES_PER_CHUNK, frameCount - fi);
    for (let k = 0; k < n; k++) off += inp.frameSizes[fi + k];
    fi += n;
  }
  const textChunkOffset = off;
  const lastChunkFrames = frameCount - (nChunks - 1) * FRAMES_PER_CHUNK;
  const needCo64 = textChunkOffset + textBytesTotal > 0xffffffff;

  // mdat 头
  const mdatHead = new W(24);
  if (mdatHeaderSize === 16) { mdatHead.u32(1); mdatHead.fourcc('mdat'); mdatHead.u64(mdatPayload + 16); }
  else { mdatHead.u32(mdatPayload + 8); mdatHead.fourcc('mdat'); }

  // ---------- moov ----------
  const w = new W(1 << 20);
  const moov = w.boxStart('moov');
  writeMvhd(w, durationMs);

  // 音频轨(id=1)
  {
    const trak = w.boxStart('trak');
    writeTkhd(w, 1, durationMs, true);
    const mdia = w.boxStart('mdia');
    writeMdhd(w, sr, totalSamples);
    writeHdlr(w, 'soun', 'SoundHandler');
    const minf = w.boxStart('minf');
    { const s = w.fullbox('smhd', 0, 0); w.u16(0); w.u16(0); w.boxEnd(s); }
    writeDinf(w);
    const stbl = w.boxStart('stbl');
    { const s = w.fullbox('stsd', 0, 0); w.u32(1); writeMp4a(w, inp.channels, sr, inp.mpegVersion, maxFrameSize, avgBitrate); w.boxEnd(s); }
    writeStts(w, [[frameCount, inp.samplesPerFrame]]);
    const stsc: Array<[number, number, number]> = nChunks === 1
      ? [[1, lastChunkFrames, 1]]
      : lastChunkFrames === FRAMES_PER_CHUNK
        ? [[1, FRAMES_PER_CHUNK, 1]]
        : [[1, FRAMES_PER_CHUNK, 1], [nChunks, lastChunkFrames, 1]];
    writeStsc(w, stsc);
    writeStsz(w, inp.frameSizes);
    writeStco(w, chunkOffsets, needCo64);
    w.boxEnd(stbl);
    w.boxEnd(minf);
    w.boxEnd(mdia);
    // tref/chap → 章节文本轨(id=2)
    const tref = w.boxStart('tref');
    const chap = w.boxStart('chap');
    w.u32(2);
    w.boxEnd(chap);
    w.boxEnd(tref);
    w.boxEnd(trak);
  }

  // 章节文本轨(id=2)
  {
    const trak = w.boxStart('trak');
    writeTkhd(w, 2, durationMs, false);
    const mdia = w.boxStart('mdia');
    writeMdhd(w, sr, totalSamples); // 与音频同时基,章节点零舍入
    writeHdlr(w, 'text', 'ChapterHandler');
    const minf = w.boxStart('minf');
    {
      const g = w.boxStart('gmhd');
      const gm = w.fullbox('gmin', 0, 0);
      w.u16(0x40); // graphicsMode = ditherCopy
      w.u16(0x8000); w.u16(0x8000); w.u16(0x8000); // opColor
      w.u16(0); // balance
      w.u16(0);
      w.boxEnd(gm);
      w.boxEnd(g);
    }
    writeDinf(w);
    const stbl = w.boxStart('stbl');
    { const s = w.fullbox('stsd', 0, 0); w.u32(1); writeTextSampleEntry(w); w.boxEnd(s); }
    writeStts(w, inp.chapters.map((c) => [1, c.durationSamples] as [number, number]));
    writeStsc(w, [[1, inp.chapters.length, 1]]);
    writeStsz(w, textSizes);
    writeStco(w, [textChunkOffset], needCo64);
    w.boxEnd(stbl);
    w.boxEnd(minf);
    w.boxEnd(mdia);
    w.boxEnd(trak);
  }

  // udta:Nero chpl + iTunes 元数据
  {
    const udta = w.boxStart('udta');
    {
      const p = w.boxStart('chpl');
      w.u8(1); w.u24(0); // version 1
      w.u32(0); // reserved
      const listed = inp.chapters.slice(0, 255); // chpl 计数为 u8
      w.u8(listed.length);
      for (const c of listed) {
        // 采样数 ×1e7 会超过 2^53,用 BigInt 精确换算到 100ns
        const t100ns = (BigInt(c.startSamples) * 10000000n + BigInt(sr) / 2n) / BigInt(sr);
        w.u64(t100ns);
        const t = te.encode(c.title);
        w.u8(Math.min(t.length, 255));
        w.bytes(t.subarray(0, 255));
      }
      w.boxEnd(p);
    }
    {
      const meta = w.fullbox('meta', 0, 0);
      writeHdlr(w, 'mdir', '');
      const ilst = w.boxStart('ilst');
      const m = inp.meta;
      if (m.title) writeIlstItem(w, '\xA9nam', m.title);
      if (m.artist) writeIlstItem(w, '\xA9ART', m.artist);
      if (m.artist) writeIlstItem(w, 'aART', m.artist);
      if (m.album) writeIlstItem(w, '\xA9alb', m.album);
      if (m.year) writeIlstItem(w, '\xA9day', m.year);
      if (m.genre) writeIlstItem(w, '\xA9gen', m.genre);
      if (m.comment) writeIlstItem(w, '\xA9cmt', m.comment);
      if (m.cover && m.cover.data.length > 0) {
        const p = w.boxStart('covr');
        const d = w.boxStart('data');
        w.u32(m.cover.mime === 'image/png' ? 14 : 13);
        w.u32(0);
        w.bytes(m.cover.data);
        w.boxEnd(d);
        w.boxEnd(p);
      }
      w.boxEnd(ilst);
      w.boxEnd(meta);
    }
    w.boxEnd(udta);
  }
  w.boxEnd(moov);

  const head = new Uint8Array(ftyp.length + mdatHead.len);
  head.set(ftyp, 0);
  head.set(mdatHead.out(), ftyp.length);
  return new Blob([head, ...inp.audioParts, textChunk, w.out()]);
}
