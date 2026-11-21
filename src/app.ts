// UI 层:四个页面(书目 / 章节编辑 / 导出 / 校验)的状态与交互。
// 音频逻辑全部在 mp3/id3/mp4write/mp4read/project 模块中,这里只做绑定。

import { indexMp3 } from './mp3.js';
import { parseId3 } from './id3.js';
import { parseM4b, M4bInfo } from './mp4read.js';
import {
  BookMeta, Chapter, emptyMeta, computeTimeline, totalDurationMs,
  validateChapters, buildM4bFromProject, buildMp3FromProject,
} from './project.js';

const meta: BookMeta = emptyMeta();
const chapters: Chapter[] = [];
let coverUrl: string | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function fmtTime(ms: number): string {
  const t = Math.round(ms);
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const mmm = t % 1000;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

// ---------- 页面切换 ----------
document.querySelectorAll<HTMLButtonElement>('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${btn.dataset.page}`));
    if (btn.dataset.page === 'export') renderExport();
  });
});

// ---------- 书目页 ----------
function bindMeta(id: string, key: keyof BookMeta) {
  $(id).addEventListener('input', (e) => {
    (meta as any)[key] = (e.target as HTMLInputElement).value;
  });
}
bindMeta('#meta-title', 'title');
bindMeta('#meta-artist', 'artist');
bindMeta('#meta-album', 'album');
bindMeta('#meta-year', 'year');
bindMeta('#meta-genre', 'genre');
bindMeta('#meta-comment', 'comment');

$('#cover-input').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  meta.cover = { data, mime: file.type === 'image/png' ? 'image/png' : 'image/jpeg' };
  if (coverUrl) URL.revokeObjectURL(coverUrl);
  coverUrl = URL.createObjectURL(file);
  $('#cover-preview').innerHTML = `<img src="${coverUrl}" alt="封面">`;
});
$('#cover-clear').addEventListener('click', () => {
  meta.cover = null;
  if (coverUrl) URL.revokeObjectURL(coverUrl);
  coverUrl = null;
  $('#cover-preview').innerHTML = '<span>无封面</span>';
  ($('#cover-input') as HTMLInputElement).value = '';
});

// ---------- 章节编辑页 ----------
async function addFiles(files: File[]) {
  const mp3s = files.filter((f) => /\.mp3$/i.test(f.name) || f.type === 'audio/mpeg');
  if (mp3s.length === 0) return;
  mp3s.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
  for (const f of mp3s) {
    const buf = new Uint8Array(await f.arrayBuffer());
    let info;
    try {
      info = indexMp3(buf);
    } catch (err) {
      alert(`「${f.name}」解析失败:${(err as Error).message}`);
      continue;
    }
    chapters.push({
      fileName: f.name,
      title: f.name.replace(/\.mp3$/i, ''),
      blob: f,
      info,
      startSamples: 0,
      startMs: 0,
      endMs: 0,
    });
  }
  computeTimeline(chapters);
  renderChapters();
}

function renderChapters() {
  const tbody = $('#chapters-table tbody');
  tbody.innerHTML = '';
  chapters.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td><input type="text" value=""></td>
      <td>${escapeHtml(c.fileName)}</td>
      <td class="num">${fmtTime(c.info.durationMs)}</td>
      <td class="num mono">${fmtTime(c.startMs)}</td>
      <td>
        <button data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" ${i === chapters.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="del">删</button>
      </td>`;
    const input = tr.querySelector('input')!;
    input.value = c.title;
    input.addEventListener('input', () => { c.title = input.value; });
    tr.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = (btn as HTMLButtonElement).dataset.act;
        if (act === 'del') chapters.splice(i, 1);
        else if (act === 'up' && i > 0) [chapters[i - 1], chapters[i]] = [chapters[i], chapters[i - 1]];
        else if (act === 'down' && i < chapters.length - 1) [chapters[i + 1], chapters[i]] = [chapters[i], chapters[i + 1]];
        computeTimeline(chapters);
        renderChapters();
      });
    });
    tbody.appendChild(tr);
  });
  const summary = $('#chapters-summary');
  if (chapters.length === 0) {
    summary.textContent = '';
  } else {
    const f = chapters[0].info;
    summary.textContent =
      `共 ${chapters.length} 章,总时长 ${fmtTime(totalDurationMs(chapters))};` +
      `${f.sampleRate}Hz / ${f.channels === 2 ? '立体声' : '单声道'} / MPEG-${f.version} Layer ${f.layer}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  addFiles(Array.from(e.dataTransfer?.files ?? []));
});
$('#file-input').addEventListener('change', (e) => {
  addFiles(Array.from((e.target as HTMLInputElement).files ?? []));
  (e.target as HTMLInputElement).value = '';
});

// ---------- 导出页 ----------
function renderExport() {
  const errors = validateChapters(chapters);
  const box = $('#export-errors');
  box.innerHTML = errors.map((e) => `<div>⚠ ${escapeHtml(e)}</div>`).join('');
  const fatal = chapters.length === 0 || errors.some((e) => !e.startsWith('共 '));
  ($('#btn-m4b') as HTMLButtonElement).disabled = fatal;
  ($('#btn-mp3') as HTMLButtonElement).disabled = fatal;
}

function download(blob: Blob, filename: string, container: HTMLElement, elapsedMs: number) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.textContent = `下载 ${filename}`;
  a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 60000));
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `<div></div><div>大小:${fmtSize(blob.size)};封装耗时 ${(elapsedMs / 1000).toFixed(2)} 秒</div>
    <div class="hint">可切到「校验」页,把成品拖进来与工程比对。</div>`;
  card.firstElementChild!.appendChild(a);
  container.appendChild(card);
}

$('#btn-m4b').addEventListener('click', () => {
  const progress = $('#export-progress');
  progress.textContent = '正在封装 M4B…';
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const blob = buildM4bFromProject(meta, chapters);
      const elapsed = performance.now() - t0;
      progress.textContent = '';
      download(blob, `${meta.title || 'audiobook'}.m4b`, $('#export-results'), elapsed);
    } catch (err) {
      progress.textContent = `导出失败:${(err as Error).message}`;
    }
  }, 30);
});

$('#btn-mp3').addEventListener('click', () => {
  const progress = $('#export-progress');
  progress.textContent = '正在写出 MP3…';
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const blob = buildMp3FromProject(meta, chapters);
      const elapsed = performance.now() - t0;
      progress.textContent = '';
      download(blob, `${meta.title || 'audiobook'}.mp3`, $('#export-results'), elapsed);
    } catch (err) {
      progress.textContent = `导出失败:${(err as Error).message}`;
    }
  }, 30);
});

// ---------- 校验页 ----------
const TOLERANCE_MS = 10;

interface VerifyChapterRow {
  index: number;
  fileTitle: string;
  fileStartMs: number;
  projTitle: string;
  projStartMs: number | null;
  deltaMs: number | null;
}

async function verifyFile(file: File) {
  $('#verify-filename').textContent = file.name;
  const box = $('#verify-results');
  box.innerHTML = '<p>解析中…</p>';
  try {
    if (/\.mp3$/i.test(file.name)) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const tag = parseId3(buf);
      if (!tag) throw new Error('未找到 ID3v2 标签');
      const audio = indexMp3(buf);
      renderVerifyMp3(box, tag, audio.durationMs, file.size);
    } else {
      const read = async (off: number, len: number) =>
        new Uint8Array(await file.slice(off, off + len).arrayBuffer());
      const info = await parseM4b(read, file.size);
      renderVerifyM4b(box, info);
    }
  } catch (err) {
    box.innerHTML = `<p class="bad">解析失败:${escapeHtml((err as Error).message)}</p>`;
  }
}

function metaRow(label: string, fileVal: string, projVal: string): string {
  const match = projVal === '' ? null : fileVal === projVal;
  const cls = match === null ? '' : match ? 'ok' : 'bad';
  const mark = match === null ? '' : match ? ' ✓' : ' ✗';
  return `<tr><td>${label}</td><td>${escapeHtml(fileVal)}</td><td>${escapeHtml(projVal)}</td><td class="${cls}">${mark}</td></tr>`;
}

function chapterTable(rows: VerifyChapterRow[], sourceNote: string): string {
  const body = rows.map((r) => {
    const ok = r.deltaMs !== null && Math.abs(r.deltaMs) <= TOLERANCE_MS && r.fileTitle === r.projTitle;
    return `<tr class="${ok ? '' : 'row-bad'}">
      <td class="num">${r.index}</td>
      <td>${escapeHtml(r.fileTitle)}</td>
      <td>${escapeHtml(r.projTitle)}</td>
      <td class="num mono">${fmtTime(r.fileStartMs)}</td>
      <td class="num mono">${r.projStartMs === null ? '—' : fmtTime(r.projStartMs)}</td>
      <td class="num mono">${r.deltaMs === null ? '—' : r.deltaMs.toFixed(1)}</td>
      <td class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>#</th><th>成品标题</th><th>工程标题</th><th>成品起点</th><th>工程起点</th><th>Δms</th><th></th></tr></thead>
    <tbody>${body}</tbody></table>
    <p class="hint">章节来源:${sourceNote};容差 ±${TOLERANCE_MS}ms。</p>`;
}

function compareChapters(fileChapters: { title: string; startMs: number }[]): VerifyChapterRow[] {
  return fileChapters.map((fc, i) => {
    const pc = chapters[i];
    return {
      index: i + 1,
      fileTitle: fc.title,
      fileStartMs: fc.startMs,
      projTitle: pc ? pc.title : '(工程中不存在)',
      projStartMs: pc ? pc.startMs : null,
      deltaMs: pc ? fc.startMs - pc.startMs : null,
    };
  });
}

function summaryLine(rows: VerifyChapterRow[], extra: string[]): string {
  const bad = rows.filter((r) => r.deltaMs === null || Math.abs(r.deltaMs) > TOLERANCE_MS || r.fileTitle !== r.projTitle);
  const countNote = rows.length === chapters.length ? '' : `章节数不一致:成品 ${rows.length} / 工程 ${chapters.length};`;
  const allOk = bad.length === 0 && rows.length === chapters.length && extra.length === 0;
  return `<p class="${allOk ? 'ok' : 'bad'}">${allOk ? '✓ 全部通过' : '✗ 存在差异'}:${countNote}` +
    (bad.length ? `${bad.length} 个章节超差或标题不符;` : '') +
    extra.map(escapeHtml).join(';') + '</p>';
}

function renderVerifyMp3(box: HTMLElement, tag: NonNullable<ReturnType<typeof parseId3>>, audioDurationMs: number, fileSize: number) {
  const t = tag.texts;
  const metaRows = [
    metaRow('标题', t['TIT2'] ?? '', meta.title),
    metaRow('演播/作者', t['TPE1'] ?? '', meta.artist),
    metaRow('专辑', t['TALB'] ?? '', meta.album),
    metaRow('年份', t['TDRC'] ?? '', meta.year),
    metaRow('类型', t['TCON'] ?? '', meta.genre),
    metaRow('备注', tag.comment, meta.comment),
    metaRow('封面', tag.cover ? `${tag.cover.mime}, ${fmtSize(tag.cover.bytes)}` : '无', meta.cover ? `${meta.cover.mime}, ${fmtSize(meta.cover.data.length)}` : '无'),
  ].join('');
  const rows = compareChapters(tag.chapters);
  const extra: string[] = [];
  if (chapters.length > 0) {
    const durDiff = Math.abs(audioDurationMs - totalDurationMs(chapters));
    if (durDiff > TOLERANCE_MS) extra.push(`音频总时长差 ${durDiff.toFixed(1)}ms`);
    if (tag.tocChildIds.length !== Math.min(tag.chapters.length, 255)) extra.push('CTOC 子项数与 CHAP 数不符');
  }
  box.innerHTML = `
    <div class="verify-section"><h3>文件概况</h3>
      <p>ID3v${escapeHtml(tag.version)},标签 ${fmtSize(tag.tagSize)};文件 ${fmtSize(fileSize)};
      音频时长 ${fmtTime(audioDurationMs)}(工程 ${fmtTime(totalDurationMs(chapters))});
      CTOC 子项 ${tag.tocChildIds.length} 个。</p></div>
    <div class="verify-section"><h3>元数据比对</h3>
      <table><thead><tr><th>字段</th><th>成品</th><th>工程</th><th></th></tr></thead><tbody>${metaRows}</tbody></table></div>
    <div class="verify-section"><h3>章节比对(${tag.chapters.length} 章)</h3>${chapterTable(rows, 'ID3v2.4 CHAP 帧')}</div>
    ${summaryLine(rows, extra)}`;
}

function renderVerifyM4b(box: HTMLElement, info: M4bInfo) {
  const g = (k: string) => info.tags[k] ?? '';
  const metaRows = [
    metaRow('标题', g('©nam'), meta.title),
    metaRow('演播/作者', g('©ART'), meta.artist),
    metaRow('专辑', g('©alb'), meta.album),
    metaRow('年份', g('©day'), meta.year),
    metaRow('类型', g('©gen'), meta.genre),
    metaRow('备注', g('©cmt'), meta.comment),
    metaRow('封面', info.coverBytes > 0 ? fmtSize(info.coverBytes) : '无', meta.cover ? fmtSize(meta.cover.data.length) : '无'),
  ].join('');
  const rows = compareChapters(info.qtChapters);
  const extra: string[] = [];
  if (chapters.length > 0 && info.audio) {
    const durDiff = Math.abs(info.audio.durationMs - totalDurationMs(chapters));
    if (durDiff > TOLERANCE_MS) extra.push(`音频总时长差 ${durDiff.toFixed(1)}ms`);
  }
  // chpl 与 QT 章节轨交叉核对
  if (info.chplChapters.length !== info.qtChapters.length) {
    extra.push(`chpl ${info.chplChapters.length} 章 / QT 轨 ${info.qtChapters.length} 章,数量不一致`);
  } else {
    for (let i = 0; i < info.chplChapters.length; i++) {
      const d = Math.abs(info.chplChapters[i].startMs - info.qtChapters[i].startMs);
      if (d > TOLERANCE_MS || info.chplChapters[i].title !== info.qtChapters[i].title) {
        extra.push(`chpl 与 QT 轨第 ${i + 1} 章不一致(Δ${d.toFixed(1)}ms)`);
        break;
      }
    }
  }
  const audioDesc = info.audio
    ? `${info.audio.sampleRate}Hz,${info.audio.frameCount} 帧,时长 ${fmtTime(info.audio.durationMs)}`
    : '未找到音频轨';
  box.innerHTML = `
    <div class="verify-section"><h3>文件概况</h3>
      <p>品牌 ${escapeHtml(info.majorBrand)};文件 ${fmtSize(info.fileSize)};${audioDesc};
      chpl 章节 ${info.chplChapters.length} 个,QuickTime 章节轨 ${info.qtChapters.length} 个。</p></div>
    <div class="verify-section"><h3>元数据比对</h3>
      <table><thead><tr><th>字段</th><th>成品</th><th>工程</th><th></th></tr></thead><tbody>${metaRows}</tbody></table></div>
    <div class="verify-section"><h3>章节比对(${info.qtChapters.length} 章)</h3>${chapterTable(rows, 'QuickTime 文本章节轨')}</div>
    ${summaryLine(rows, extra)}`;
}

$('#verify-input').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) verifyFile(f);
  (e.target as HTMLInputElement).value = '';
});
const vdz = $('#verify-dropzone');
vdz.addEventListener('dragover', (e) => e.preventDefault());
vdz.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) verifyFile(f);
});
