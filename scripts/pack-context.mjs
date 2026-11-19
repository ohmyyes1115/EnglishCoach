import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT_FILE = path.join(ROOT, 'context.txt');

const fixedFiles = ['index.html', 'styles.css'];
const jsDir = path.join(ROOT, 'js');
const jsFiles = fs.existsSync(jsDir)
  ? fs.readdirSync(jsDir)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => `js/${f}`)
  : [];

const targetFiles = [
  ...fixedFiles.filter((f) => fs.existsSync(path.join(ROOT, f))),
  ...jsFiles
];

// 1. 先對所有 JS 檔做語法檢查
for (const relPath of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, relPath)], { stdio: 'pipe' });
  } catch (err) {
    console.error(`❌ 語法錯誤：${relPath}`);
    console.error(err.stderr?.toString() || err.message);
    process.exit(1);
  }
}

// 2. 組合給 AI 的檔頭規範 + 所有原始碼
const header = [
  '# EnglishCoach Project Context',
  `- Generated: ${new Date().toISOString()}`,
  `- Files (${targetFiles.length}): ${targetFiles.join(', ')}`,
  '',
  '## Collaboration Rules',
  '1. Pure static web app using native ES Modules (<script type="module">), deployed directly to GitHub Pages (no Vite/Webpack).',
  '2. Modify only affected files and preserve all existing features.',
  '3. Never use placeholders like `// ...略`. For full-file output, output 1 file per turn and end with `// EOF: <filepath>`.',
  ''
].join('\n');

const sections = targetFiles.map((relPath) => {
  const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  return `\n===== FILE: ${relPath} =====\n${content}`;
});

const output = header + sections.join('\n');
fs.writeFileSync(OUT_FILE, output, 'utf8');

const sizeKb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
console.log(`✅ 語法檢查全部通過，已產生 context.txt（${targetFiles.length} 個檔案，${sizeKb} KB）`);
targetFiles.forEach((f) => {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).length;
  console.log(`   - ${f} (${lines} lines)`);
});