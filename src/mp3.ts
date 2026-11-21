// MP3 帧级索引器:不解码音频,只解析帧头。
// 每一帧记录字节大小与采样数,章节时间点 = 前缀采样数累加 / 采样率,
// 舍入到毫秒后误差 ≤ 0.5ms,满足 10ms 以内的要求。

export interface FrameHeader {
  version: 1 | 2 | 2.5; // MPEG 版本
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  channels: 1 | 2;
  frameSize: number; // 含帧头的整帧字节数
  samples: number; // 该帧包含的采样数(每声道)
}

const BITRATE_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const BITRATE_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR_V1 = [44100, 48000, 32000];
const SR_V2 = [22050, 24000, 16000];
const SR_V25 = [11025, 12000, 8000];

export function parseFrameHeader(b: Uint8Array, o: number): FrameHeader | null {
  if (o + 4 > b.length) return null;
  const h = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (((h & 0xffe00000) >>> 0) !== 0xffe00000) return null; // 11 位同步
  const verBits = (h >>> 19) & 3;
  if (verBits === 1) return null; // 保留
  const layerBits = (h >>> 17) & 3;
  if (layerBits === 0) return null; // 保留
  const version = verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const brIdx = (h >>> 12) & 0xf;
  const srIdx = (h >>> 10) & 3;
  if (brIdx === 0 || brIdx === 0xf || srIdx === 3) return null; // 0=自由格式,15=坏
  const v1 = version === 1;
  const brTable = v1 ? (layer === 1 ? BITRATE_V1_L1 : layer === 2 ? BITRATE_V1_L2 : BITRATE_V1_L3) : BITRATE_V2;
  const bitrateKbps = brTable[brIdx];
  const sampleRate = (v1 ? SR_V1 : version === 2 ? SR_V2 : SR_V25)[srIdx];
  const padding = (h >>> 9) & 1;
  const channels = ((h >>> 6) & 3) === 3 ? 1 : 2;
  let samples: number;
  let frameSize: number;
  if (layer === 1) {
    samples = 384;
    frameSize = Math.floor((12 * bitrateKbps * 1000) / sampleRate + padding) * 4;
  } else if (layer === 3 && !v1) {
    samples = 576; // MPEG-2/2.5 Layer III
    frameSize = Math.floor((72 * bitrateKbps * 1000) / sampleRate) + padding;
  } else {
    samples = 1152;
    frameSize = Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding;
  }
  return { version, layer, bitrateKbps, sampleRate, channels, frameSize, samples };
}

export interface Mp3FileInfo {
  frameDataStart: number; // 第一帧在文件中的偏移(跳过 ID3v2)
  frameDataEnd: number; // 最后一帧结束偏移(去掉 ID3v1)
  frameSizes: Uint32Array; // 每帧字节数
  frameCount: number;
  samplesPerFrame: number; // 首帧采样数
  uniformSamples: boolean; // 全文每帧采样数是否一致(不一致则不能进 M4B)
  sampleRate: number;
  channels: number;
  version: number;
  layer: number;
  totalSamples: number;
  durationMs: number;
  skippedBytes: number; // 帧流中跳过的垃圾字节(健壮性统计)
}

export function indexMp3(buf: Uint8Array): Mp3FileInfo {
  let start = 0;
  // 跳过 ID3v2 标签
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + sz;
    if (buf[5] & 0x10) start += 10; // v2.4 footer
  }
  // 去掉 ID3v1(尾部 128 字节 "TAG")
  let end = buf.length;
  if (end >= 128 && buf[end - 128] === 0x54 && buf[end - 127] === 0x41 && buf[end - 126] === 0x47) end -= 128;

  // 找第一帧:要求下一帧位置也能同步,避免把伪同步当帧头
  let pos = start;
  let first: FrameHeader | null = null;
  let firstPos = 0;
  while (pos + 4 <= end) {
    const h = parseFrameHeader(buf, pos);
    if (h && pos + h.frameSize <= end) {
      const next = pos + h.frameSize;
      if (next + 4 > end || parseFrameHeader(buf, next)) {
        first = h;
        firstPos = pos;
        break;
      }
    }
    pos++;
  }
  if (!first) throw new Error('未找到有效的 MP3 音频帧(可能不是 MP3 文件)');

  let sizes = new Uint32Array(1 << 16);
  let count = 0;
  let totalSamples = 0;
  let skipped = firstPos - start;
  let uniform = true;
  pos = firstPos;
  while (pos + 4 <= end) {
    let h = parseFrameHeader(buf, pos);
    if (!h || pos + h.frameSize > end) {
      // 帧头损坏:向后重新同步
      let p = pos + 1;
      let found = false;
      while (p + 4 <= end) {
        const h2 = parseFrameHeader(buf, p);
        if (h2 && p + h2.frameSize <= end) {
          skipped += p - pos;
          pos = p;
          h = h2;
          found = true;
          break;
        }
        p++;
      }
      if (!found) break;
    }
    if (!h) break;
    if (count === sizes.length) {
      const ns = new Uint32Array(sizes.length * 2);
      ns.set(sizes);
      sizes = ns;
    }
    sizes[count++] = h.frameSize;
    totalSamples += h.samples;
    if (h.samples !== first.samples) uniform = false;
    pos += h.frameSize;
  }

  return {
    frameDataStart: firstPos,
    frameDataEnd: pos,
    frameSizes: sizes.subarray(0, count),
    frameCount: count,
    samplesPerFrame: first.samples,
    uniformSamples: uniform,
    sampleRate: first.sampleRate,
    channels: first.channels,
    version: first.version,
    layer: first.layer,
    totalSamples,
    durationMs: (totalSamples * 1000) / first.sampleRate,
    skippedBytes: skipped,
  };
}
