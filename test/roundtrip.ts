// 端到端测试:
//  1. 读取合成素材 → 建工程 → 导出 M4B / MP3
//  2. 用自带解析器重新解析成品,章节点与工程比对(容差 10ms)
//  3. 调 ffprobe 做第三方校验(章节数、起点、标题)
//  4. 30 小时长篇(book-c)性能测试:索引 + 封装 + 落盘总耗时应 < 60s
// 前置:先运行 npm run gen-samples

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { indexMp3 } from '../src/mp3.js';
import { parseId3 } from '../src/id3.js';
import { parseM4b } from '../src/mp4read.js';
import {
  BookMeta, Chapter, computeTimeline, totalDurationMs,
  validateChapters, buildM4bFromProject, buildMp3FromProject,
} from '../src/project.js';

const ROOT = join(import.meta.dirname, '..', '..');
const OUTDIR = join(ROOT, 'test', 'out');
mkdirSync(OUTDIR, { recursive: true });

const TOL = 10; // ms
let failures = 0;
function check(cond: boolean, label: string) {
  if (!cond) { failures++; console.error(`  ✗ ${label}`); }
}
function ok(label: string) { console.log(`  ✓ ${label}`); }

// 1x1 PNG,测试封面写入/读取
const COVER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function loadProject(dir: string, meta: BookMeta): { meta: BookMeta; chapters: Chapter[] } {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }));
  const chapters: Chapter[] = files.map((name) => {
    const buf = readFileSync(join(dir, name));
    const info = indexMp3(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    return {
      fileName: name,
      title: name.replace(/\.mp3$/i, ''),
      blob: new Blob([buf]),
      info,
      startSamples: 0, startMs: 0, endMs: 0,
    };
  });
  computeTimeline(chapters);
  return { meta, chapters };
}

interface FfChapter { start_time: string; tags?: { title?: string } }

function ffprobe(file: string): { chapters: FfChapter[]; tags: Record<string, string> } | null {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_chapters', '-show_format', file,
    ], { maxBuffer: 64 * 1024 * 1024 }).toString();
    const j = JSON.parse(out);
    return { chapters: j.chapters ?? [], tags: j.format?.tags ?? {} };
  } catch (e) {
    console.warn(`  (ffprobe 不可用或失败,跳过第三方校验:${(e as Error).message.split('\n')[0]})`);
    return null;
  }
}

async function roundtrip(bookDir: string, bookName: string) {
  console.log(`\n== 《${bookName}》 ==`);
  const meta: BookMeta = {
    title: bookName, artist: '演播:测试员', album: `${bookName}(有声书)`,
    year: '2026', genre: 'Audiobook', comment: '端到端测试',
    cover: { data: new Uint8Array(COVER), mime: 'image/png' },
  };
  const { chapters } = loadProject(bookDir, meta);
  const errors = validateChapters(chapters).filter((e) => !e.startsWith('共 '));
  check(errors.length === 0, `工程校验应通过:${errors.join(';')}`);
  console.log(`  ${chapters.length} 章,总时长 ${(totalDurationMs(chapters) / 3600000).toFixed(3)} 小时`);

  // ---- M4B ----
  const t0 = performance.now();
  const m4b = buildM4bFromProject(meta, chapters);
  const m4bMs = performance.now() - t0;
  const m4bPath = join(OUTDIR, `${bookName}.m4b`);
  writeFileSync(m4bPath, Buffer.from(await m4b.arrayBuffer()));
  const m4bBuf = readFileSync(m4bPath);
  const info = await parseM4b(
    async (off, len) => new Uint8Array(m4bBuf.buffer as ArrayBuffer, m4bBuf.byteOffset + off, len),
    m4b.size
  );
  check(info.qtChapters.length === chapters.length, `QT 章节数 ${info.qtChapters.length} ≠ ${chapters.length}`);
  check(info.chplChapters.length === Math.min(chapters.length, 255), `chpl 章节数 ${info.chplChapters.length}`);
  let maxDev = 0;
  for (let i = 0; i < Math.min(info.qtChapters.length, chapters.length); i++) {
    const dev = Math.abs(info.qtChapters[i].startMs - chapters[i].startMs);
    maxDev = Math.max(maxDev, dev);
    check(info.qtChapters[i].title === chapters[i].title, `QT 第${i + 1}章标题不符`);
  }
  for (let i = 0; i < Math.min(info.chplChapters.length, chapters.length); i++) {
    maxDev = Math.max(maxDev, Math.abs(info.chplChapters[i].startMs - chapters[i].startMs));
  }
  check(maxDev <= TOL, `M4B 章节最大偏差 ${maxDev.toFixed(2)}ms 超过 ${TOL}ms`);
  check(info.tags['©nam'] === meta.title, 'M4B 标题元数据不符');
  check(info.tags['©ART'] === meta.artist, 'M4B 演播者元数据不符');
  check(info.coverBytes === COVER.length, 'M4B 封面大小不符');
  check(info.audio !== null && Math.abs(info.audio.durationMs - totalDurationMs(chapters)) <= TOL, 'M4B 音频时长不符');
  ok(`M4B:封装 ${m4bMs.toFixed(0)}ms,章节最大偏差 ${maxDev.toFixed(2)}ms,元数据一致`);

  // ffprobe 第三方校验
  const ff = ffprobe(m4bPath);
  if (ff) {
    const starts = [...new Set(ff.chapters.map((c) => Math.round(parseFloat(c.start_time) * 1000)))].sort((a, b) => a - b);
    check(starts.length === chapters.length, `ffprobe 读到 ${starts.length} 个章节起点(去重后),期望 ${chapters.length}`);
    let ffDev = 0;
    for (let i = 0; i < Math.min(starts.length, chapters.length); i++) {
      ffDev = Math.max(ffDev, Math.abs(starts[i] - chapters[i].startMs));
    }
    check(ffDev <= TOL, `ffprobe 章节最大偏差 ${ffDev}ms`);
    ok(`ffprobe(M4B):${ff.chapters.length} 章,去重起点最大偏差 ${ffDev.toFixed(1)}ms`);
  }

  // ---- MP3 ----
  const t1 = performance.now();
  const mp3 = buildMp3FromProject(meta, chapters);
  const mp3Ms = performance.now() - t1;
  const mp3Path = join(OUTDIR, `${bookName}.mp3`);
  const mp3Buf = Buffer.from(await mp3.arrayBuffer());
  writeFileSync(mp3Path, mp3Buf);
  const tag = parseId3(new Uint8Array(mp3Buf.buffer, mp3Buf.byteOffset, mp3Buf.length));
  check(tag !== null, 'MP3 应含 ID3v2 标签');
  if (tag) {
    check(tag.chapters.length === chapters.length, `CHAP 数 ${tag.chapters.length} ≠ ${chapters.length}`);
    check(tag.tocChildIds.length === Math.min(chapters.length, 255), 'CTOC 子项数不符');
    let maxDev2 = 0;
    for (let i = 0; i < Math.min(tag.chapters.length, chapters.length); i++) {
      maxDev2 = Math.max(maxDev2, Math.abs(tag.chapters[i].startMs - chapters[i].startMs));
      check(tag.chapters[i].title === chapters[i].title, `CHAP 第${i + 1}章标题不符`);
      if (i + 1 < tag.chapters.length) {
        check(tag.chapters[i].endMs === tag.chapters[i + 1].startMs, `第${i + 1}章结束≠下一章开始`);
      }
    }
    check(maxDev2 <= TOL, `MP3 章节最大偏差 ${maxDev2.toFixed(2)}ms 超过 ${TOL}ms`);
    check(tag.texts['TIT2'] === meta.title, 'MP3 标题不符');
    check(tag.texts['TPE1'] === meta.artist, 'MP3 演播者不符');
    check(tag.cover !== null && tag.cover.bytes === COVER.length, 'MP3 封面不符');
    // 音频帧总时长与工程一致
    const audio = indexMp3(new Uint8Array(mp3Buf.buffer, mp3Buf.byteOffset, mp3Buf.length));
    check(Math.abs(audio.durationMs - totalDurationMs(chapters)) <= TOL, 'MP3 音频总时长不符');
    ok(`MP3:封装 ${mp3Ms.toFixed(0)}ms,CHAP 最大偏差 ${maxDev2.toFixed(2)}ms,CTOC ${tag.tocChildIds.length} 子项`);
  }
  const ff2 = ffprobe(mp3Path);
  if (ff2) {
    check(ff2.chapters.length === chapters.length, `ffprobe(MP3)读到 ${ff2.chapters.length} 章,期望 ${chapters.length}`);
    let ffDev = 0;
    for (let i = 0; i < Math.min(ff2.chapters.length, chapters.length); i++) {
      ffDev = Math.max(ffDev, Math.abs(parseFloat(ff2.chapters[i].start_time) * 1000 - chapters[i].startMs));
      const want = chapters[i].title;
      const got = ff2.chapters[i].tags?.title ?? '';
      check(got === want, `ffprobe(MP3)第${i + 1}章标题 "${got}" ≠ "${want}"`);
    }
    check(ffDev <= TOL, `ffprobe(MP3)章节最大偏差 ${ffDev.toFixed(1)}ms`);
    ok(`ffprobe(MP3):章节起点最大偏差 ${ffDev.toFixed(1)}ms`);
  }
}

async function perfTest(bookDir: string) {
  console.log(`\n== 性能测试:30 小时长篇 ==`);
  const files = readdirSync(bookDir).filter((f) => f.endsWith('.mp3')).sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }));
  const t0 = performance.now();
  const chapters: Chapter[] = [];
  for (const name of files) {
    const buf = readFileSync(join(bookDir, name));
    const info = indexMp3(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    chapters.push({
      fileName: name, title: name.replace(/\.mp3$/i, ''), blob: new Blob([buf]),
      info, startSamples: 0, startMs: 0, endMs: 0,
    });
  }
  computeTimeline(chapters);
  const tIndex = performance.now() - t0;
  const hours = totalDurationMs(chapters) / 3600000;
  console.log(`  ${files.length} 个文件,${hours.toFixed(2)} 小时,索引 ${tIndex.toFixed(0)}ms`);

  const meta: BookMeta = {
    title: '长河录', artist: '演播:测试员', album: '长河录(有声书)',
    year: '2026', genre: 'Audiobook', comment: '', cover: null,
  };
  const t1 = performance.now();
  const m4b = buildM4bFromProject(meta, chapters);
  const tMux = performance.now() - t1;
  const t2 = performance.now();
  const out = join(OUTDIR, '长河录.m4b');
  writeFileSync(out, Buffer.from(await m4b.arrayBuffer()));
  const tWrite = performance.now() - t2;
  const total = performance.now() - t0;
  console.log(`  M4B 封装 ${tMux.toFixed(0)}ms,物化+写盘 ${tWrite.toFixed(0)}ms,合计 ${(total / 1000).toFixed(2)}s(${(m4b.size / (1 << 30)).toFixed(2)} GB)`);
  check(total < 60000, `30 小时打包总耗时 ${(total / 1000).toFixed(1)}s 超过 60s`);

  const t3 = performance.now();
  const mp3 = buildMp3FromProject(meta, chapters);
  writeFileSync(join(OUTDIR, '长河录.mp3'), Buffer.from(await mp3.arrayBuffer()));
  const tMp3 = performance.now() - t3;
  console.log(`  MP3 写出 ${tMp3.toFixed(0)}ms`);
  check(tMp3 < 60000, 'MP3 写出超时');
}

async function main() {
  const samples = join(ROOT, 'samples');
  const a = join(samples, 'book-a-xueyexing');
  const b = join(samples, 'book-b-dengxia');
  const c = join(samples, 'book-c-changhe');
  if (!existsSync(a) || !existsSync(b)) {
    console.error('请先运行 npm run gen-samples 生成测试素材');
    process.exit(1);
  }
  await roundtrip(a, '雪夜行');
  await roundtrip(b, '灯下短篇集');
  if (existsSync(c) && !process.argv.includes('--skip-perf')) await perfTest(c);

  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
