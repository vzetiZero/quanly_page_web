import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const APP_OUT = path.join(DIST, 'News247US-Studio');
const APP_FILES = path.join(APP_OUT, 'app');
const VENV_OUT = path.join(APP_FILES, '.venv');
const EXE_OUT = path.join(APP_OUT, 'News247US-Studio.exe');
const BUILD_TMP = path.join(ROOT, 'build');
const VENV_PYTHON = path.join(VENV_OUT, 'Scripts', 'python.exe');

// --only-exe: dựng lại launcher từ app/ đã có sẵn.
// --skip-python: chép lại mã nguồn nhưng dùng .venv đã build (khỏi copy Python + pip, tiết kiệm ~2 phút).
const ONLY_EXE = process.argv.includes('--only-exe');
const SKIP_PYTHON = process.argv.includes('--skip-python');

const step = (msg) => console.log(`\n=== ${msg} ===`);

function robocopy(src, dest, { excludeDirs = [], excludeFiles = [] } = {}) {
  const args = [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/MT:16'];
  if (excludeDirs.length) args.push('/XD', ...excludeDirs);
  if (excludeFiles.length) args.push('/XF', ...excludeFiles);
  const res = spawnSync('robocopy', args, { encoding: 'utf8', windowsHide: true });
  if (res.status >= 8) {
    throw new Error(`robocopy ${src} -> ${dest} that:\n${res.stdout}\n${res.stderr}`);
  }
}

// robocopy chỉ nhận thư mục nguồn, nên file lẻ đi qua fs.
function copy(src, dest) {
  if (fs.statSync(src).isDirectory()) robocopy(src, dest);
  else fs.cpSync(src, dest);
}

// Ưu tiên .env đang dùng, rồi bản trong dist (khi build --skip-python mà .env gốc bị đổi tên),
// cuối fallback .env.example.
function resolveEnvSource() {
  const candidates = [path.join(ROOT, '.env'), path.join(APP_FILES, '.env'), path.join(ROOT, '.env.example')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Không tìm thấy .env / .env.example ở ${ROOT}.`);
  if (found !== candidates[0]) console.log(`[env] dùng ${found} (thiếu .env ở thư mục dự án)`);
  return found;
}

function copyFile(src, dest, options = {}) {
  if (path.resolve(src) === path.resolve(dest)) return;
  fs.cpSync(src, dest, options);
}

function copyAppSources({ keepVenv }) {
  step('2/6 Chép mã nguồn app');
  if (!keepVenv) fs.rmSync(APP_OUT, { recursive: true, force: true });
  fs.mkdirSync(APP_FILES, { recursive: true });
  for (const item of ['server.js', 'lib', 'public', 'python', 'node_modules']) {
    copy(path.join(ROOT, item), path.join(APP_FILES, item));
  }
  copyFile(resolveEnvSource(), path.join(APP_FILES, '.env'));
  fs.mkdirSync(path.join(APP_FILES, 'data'), { recursive: true });
  const dataSrc = path.join(ROOT, 'data');
  if (fs.existsSync(dataSrc)) {
    for (const file of fs.readdirSync(dataSrc)) {
      fs.cpSync(path.join(dataSrc, file), path.join(APP_FILES, 'data', file), { recursive: true, force: true });
    }
  }
}

// server.js tìm .venv/Scripts/python.exe. Interpreter phải tự tìm được stdlib và DLL
// mà không tham chiếu Python của máy build, nên chép cả bản cài vào .venv rồi đặt
// python.exe + DLL song song trong Scripts/ (khi đó sys.prefix == .venv).
function bundlePython() {
  const systemPython = execFileSync('python', ['-c', 'import sys;print(sys.base_prefix)'], { encoding: 'utf8' }).trim();
  step(`3/6 Đóng gói Python từ ${systemPython}`);
  robocopy(systemPython, VENV_OUT, {
    excludeDirs: ['Doc', 'tcl', 'include', 'libs', '__pycache__'],
    excludeFiles: ['*.pyc']
  });
  for (const file of fs.readdirSync(VENV_OUT)) {
    if (/^python.*\.exe$/.test(file) || /\.(dll|zip)$/i.test(file)) {
      fs.cpSync(path.join(VENV_OUT, file), path.join(VENV_OUT, 'Scripts', file));
    }
  }
  const check = execFileSync(VENV_PYTHON, [
    '-c',
    'import sys,os;print(sys.version_info[:2]);print(sys.prefix);print(os.path.isfile(os.path.join(sys.prefix,"Lib","os.py")))'
  ], { encoding: 'utf8' }).trim().split(/\r?\n/);
  console.log(`[python] version=${check[0]} prefix=${check[1]} stdlib_ok=${check[2]}`);
  if (check[2] !== 'True') throw new Error('Python đóng gói không tự tìm được stdlib.');

  step('4/6 Cài dependencies Python vào bản đóng gói');
  const pip = spawnSync(VENV_PYTHON, ['-m', 'pip', 'install', '--no-warn-script-location', '-r', path.join(APP_FILES, 'python', 'requirements.txt')], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (pip.status !== 0) throw new Error('pip install thất bại:\n' + pip.stdout + pip.stderr);
  const imports = execFileSync(VENV_PYTHON, ['-c', 'import uvicorn, fastapi, bleach, tinycss2, yt_dlp; print("OK")'], { encoding: 'utf8' }).trim();
  if (imports !== 'OK') throw new Error('Python deps thiếu: ' + imports);
}

const LAUNCHER_SOURCE = `'use strict';
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const dir = path.dirname(process.execPath);
const appDir = path.join(dir, 'app');
const serverPath = path.join(appDir, 'server.js');

// Khi double-click, lỗi mà in ra rồi thoát ngay sẽ khiến console biến mất trước khi kịp đọc.
process.on('exit', (code) => {
  if (!code) return;
  console.error('\\nCo loi xay ra (exit ' + code + '). Bam Enter de dong cua so...');
  try {
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
  } catch {}
});

if (!fs.existsSync(serverPath)) {
  console.error('[launcher] Khong tim thay: ' + serverPath);
  console.error('[launcher] Giu nguyen cau truc: News247US-Studio.exe + thu muc app/ ben canh.');
  process.exit(1);
}

console.log('News247US Studio - dang khoi dong...');
process.chdir(appDir);
createRequire(path.join(appDir, 'noop.js'))(serverPath);
`;

function buildExe() {
  step('5/6 Build launcher exe (Node SEA)');
  fs.mkdirSync(BUILD_TMP, { recursive: true });
  fs.writeFileSync(path.join(BUILD_TMP, 'launcher.cjs'), LAUNCHER_SOURCE);
  const seaConfig = {
    main: path.join(BUILD_TMP, 'launcher.cjs'),
    output: path.join(BUILD_TMP, 'sea.blob'),
    disableExperimentalSEAWarning: true
  };
  fs.writeFileSync(path.join(BUILD_TMP, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD_TMP, 'sea-config.json')], { stdio: 'inherit' });

  fs.cpSync(process.execPath, EXE_OUT);
  const fuse = fs.readFileSync(EXE_OUT, 'latin1').match(/NODE_SEA_FUSE_[a-f0-9]{32}/)?.[0];
  if (!fuse) throw new Error('Khong doc duoc SEA fuse tu node.exe.');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    EXE_OUT,
    'NODE_SEA_BLOB',
    seaConfig.output,
    '--sentinel-fuse',
    fuse
  ], { stdio: 'inherit' });
}

function writeReadme() {
  step('6/6 Viết README bản đóng gói');
  fs.writeFileSync(
    path.join(APP_OUT, 'README.txt'),
    `News247US Studio (ban portable)

Khuong: double-click News247US-Studio.exe -> mo http://localhost:4300
Khong can cai Node.js hoac Python tren may chay.

Neu cua so dong ngay lập tuc: thuong la cong 4300 hoac 8000 dang bi
chuong trinh khac chiem (vi du ban dang chay "npm start" o mot cua so khac).
Don mot cua so lenh roi chay News247US-Studio.exe de doc duoc thong bao loi.

Cau truc:
  News247US-Studio.exe   = Node.js + launcher
  app/server.js          = dashboard Express
  app/.venv              = Python 3.12 + uvicorn/fastapi/yt-dlp (worker)
  app/.env               = cong chay, cookie, API keys

Doi cai dat: mo app/.env (PORT, PYTHON_PORT, OPEN_BROWSER).
Xoa du lieu dang luong trong app/data/ tru khi chia se ban nay cho nguoi khac.
`
  );
}

function totalSizeMb(p) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, entry.name);
      if (entry.isDirectory()) walk(fp);
      else total += fs.statSync(fp).size;
    }
  };
  walk(p);
  return (total / 1024 / 1024).toFixed(0);
}

step('1/6 Chuẩn bị thư mục dist');
if (ONLY_EXE) {
  console.log('[skip] giữ nguyên app/, chỉ dựng lại exe');
} else if (SKIP_PYTHON) {
  if (!fs.existsSync(VENV_PYTHON)) throw new Error(`Chưa có ${VENV_PYTHON}. Chạy build đầy đủ trước.`);
  copyAppSources({ keepVenv: true });
  console.log('[skip] dùng lại .venv đã build');
} else {
  copyAppSources({ keepVenv: false });
  bundlePython();
}
buildExe();
writeReadme();

console.log(`\nXong: ${APP_OUT}`);
console.log(`  exe    : ${EXE_OUT}`);
console.log(`  tinh dung luong: ${totalSizeMb(APP_OUT)} MB`);
