// 工程模型:章节列表 + 书目元数据,以及由工程生成 M4B / MP3 成品的组装逻辑。
// 浏览器 UI 与 Node 测试共用这一层。

import { Mp3FileInfo } from './mp3.js';
import { writeId3v24 } from './id3.js';
import { buildM4b, M4bMeta } from './mp4write.js';

export interface BookMeta {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  comment: string;
  cover: { data: Uint8Array; mime: string } | null;
}

export interface Chapter {
  fileName: string;
  title: string; // 可编辑,默认取文件名去扩展名
  blob: Blob; // 原始文件(输出时用 slice 零拷贝引用)
  info: Mp3FileInfo;
  startSamples: number;
  startMs: number;
  endMs: number;
}

export function emptyMeta(): BookMeta {
  return { title: '', artist: '', album: '', year: '', genre: 'Audiobook', comment: '', cover: null };
}

// 按采样数累加生成章节点,舍入到毫秒,单点误差 ≤0.5ms
export function computeTimeline(chapters: Chapter[]): void {
  const sr = chapters.length > 0 ? chapters[0].info.sampleRate : 44100;
  let s = 0;
  for (const c of chapters) {
    c.startSamples = s;
    c.startMs = Math.round((s * 1000) / sr);
    s += c.info.totalSamples;
    c.endMs = Math.round((s * 1000) / sr);
  }
}

export function totalDurationMs(chapters: Chapter[]): number {
  return chapters.length > 0 ? chapters[chapters.length - 1].endMs : 0;
}

// 导出前校验:整本书的编码参数必须一致,否则 M4B 的 stts/stsd 无法描述
export function validateChapters(chapters: Chapter[]): string[] {
  const errors: string[] = [];
  if (chapters.length === 0) {
    errors.push('尚未添加任何章节文件');
    return errors;
  }
  const f = chapters[0].info;
  chapters.forEach((c, i) => {
    const g = c.info;
    const label = `第 ${i + 1} 个文件「${c.fileName}」`;
    if (g.sampleRate !== f.sampleRate) errors.push(`${label}采样率 ${g.sampleRate}Hz,与全书 ${f.sampleRate}Hz 不一致`);
    if (g.channels !== f.channels) errors.push(`${label}声道数 ${g.channels},与全书 ${f.channels} 不一致`);
    if (g.layer !== f.layer) errors.push(`${label}编码层 Layer ${g.layer},与全书 Layer ${f.layer} 不一致`);
    if (!g.uniformSamples) errors.push(`${label}帧采样数不固定(混合 MPEG 版本),无法精确封装`);
    if (g.frameCount === 0) errors.push(`${label}不含有效音频帧`);
  });
  if (chapters.length > 255) {
    errors.push(`共 ${chapters.length} 章:Nero chpl 与 CTOC 目录最多列 255 章(QuickTime 章节轨与 CHAP 帧不受限,超出部分仍可写出)`);
  }
  return errors;
}

function audioParts(chapters: Chapter[]): Blob[] {
  return chapters.map((c) => c.blob.slice(c.info.frameDataStart, c.info.frameDataEnd));
}

function combinedFrameSizes(chapters: Chapter[]): Uint32Array {
  let total = 0;
  for (const c of chapters) total += c.info.frameCount;
  const sizes = new Uint32Array(total);
  let o = 0;
  for (const c of chapters) {
    sizes.set(c.info.frameSizes, o);
    o += c.info.frameCount;
  }
  return sizes;
}

export function buildM4bFromProject(meta: BookMeta, chapters: Chapter[]): Blob {
  const f = chapters[0].info;
  const m4bMeta: M4bMeta = { ...meta };
  return buildM4b({
    sampleRate: f.sampleRate,
    channels: f.channels,
    samplesPerFrame: f.samplesPerFrame,
    mpegVersion: f.version,
    frameSizes: combinedFrameSizes(chapters),
    audioParts: audioParts(chapters),
    chapters: chapters.map((c) => ({
      title: c.title,
      startSamples: c.startSamples,
      durationSamples: c.info.totalSamples,
    })),
    meta: m4bMeta,
  });
}

export function buildMp3FromProject(meta: BookMeta, chapters: Chapter[]): Blob {
  const tag = writeId3v24({
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    year: meta.year,
    genre: meta.genre,
    comment: meta.comment,
    cover: meta.cover,
    chapters: chapters.map((c, i) => ({ id: `ch${i}`, startMs: c.startMs, endMs: c.endMs, title: c.title })),
  });
  return new Blob([tag, ...audioParts(chapters)]);
}
