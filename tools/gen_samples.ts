// 测试素材合成:按几本书的章节结构生成分章 MP3。
//  - book-a《雪夜行》:12 章,44.1kHz 立体声 128k,ffmpeg 合成真实可播放音频
//  - book-b《灯下短篇集》:63 章,22.05kHz 单声道 64k(MPEG-2,每帧 576 采样,考验另一条代码路径)
//  - book-c《长河录》:40 章 × 45 分钟 = 30 小时,直接合成合法帧(供 1 分钟性能验证,非可听音频)
// 用法:node dist/tools/gen_samples.js [--only=a|b|c]

import { execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'samples');

interface BookSpec {
  key: string;
  dir: string;
  title: string;
  chapters: number;
  sampleRate: number;
  channels: number;
  bitrate: string;
  duration: (i: number) => number; // 秒,带非整毫秒,考验换算精度
  synthetic: boolean; // true = 直接写帧,不走 ffmpeg
}

const books: BookSpec[] = [
  {
    key: 'a', dir: 'book-a-xueyexing', title: '雪夜行', chapters: 12,
    sampleRate: 44100, channels: 2, bitrate: '128k',
    duration: (i) => 420 + ((i * 733) % 540) + ((i * 37) % 100) / 100 + 0.013,
    synthetic: false,
  },
  {
    key: 'b', dir: 'book-b-dengxia', title: '灯下短篇集', chapters: 63,
    sampleRate: 22050, channels: 1, bitrate: '64k',
    duration: (i) => 75 + ((i * 389) % 180) + ((i * 53) % 100) / 100 + 0.007,
    synthetic: false,
  },
  {
    key: 'c', dir: 'book-c-changhe', title: '长河录', chapters: 40,
    sampleRate: 44100, channels: 2, bitrate: '128k',
    duration: () => 2700, // 45 分钟 × 40 = 30 小时
    synthetic: true,
  },
];

function chapterName(i: number): string {
  return `第${String(i + 1).padStart(2, '0')}章.mp3`;
}

async function genWithFfmpeg(book: BookSpec, i: number, outPath: string): Promise<void> {
  const dur = book.duration(i);
  const freq = 220 + ((i * 47) % 440); // 各章音调不同,便于听辨
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur.toFixed(3)}`,
    '-ar', String(book.sampleRate), '-ac', String(book.channels),
    '-c:a', 'libmp3lame', '-b:a', book.bitrate,
    '-id3v2_version', '3', '-metadata', `title=${book.title} 第${i + 1}章`,
    outPath,
  ]);
}

// 直接合成 CBR 帧流:MPEG-1 Layer III 128kbps 44.1kHz 立体声,帧长 417 字节
async function genSynthetic(book: BookSpec, i: number, outPath: string): Promise<void> {
  const seconds = book.duration(i);
  const frames = Math.round((seconds * 44100) / 1152);
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frame = Buffer.alloc(417);
  header.copy(frame, 0);
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(outPath);
    ws.on('error', reject);
    ws.on('finish', resolve);
    let n = 0;
    const write = () => {
      while (n < frames) {
        n++;
        if (!ws.write(frame)) { ws.once('drain', write); return; }
      }
      ws.end();
    };
    write();
  });
}

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
  for (const book of books) {
    if (only && book.key !== only) continue;
    const dir = join(OUT, book.dir);
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const jobs: Promise<void>[] = [];
    const POOL = 6;
    let next = 0;
    const worker = async () => {
      while (next < book.chapters) {
        const i = next++;
        const out = join(dir, chapterName(i));
        if (existsSync(out)) continue;
        if (book.synthetic) await genSynthetic(book, i, out);
        else await genWithFfmpeg(book, i, out);
      }
    };
    for (let k = 0; k < POOL; k++) jobs.push(worker());
    await Promise.all(jobs);
    console.log(`《${book.title}》 ${book.chapters} 章完成,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${dir}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
