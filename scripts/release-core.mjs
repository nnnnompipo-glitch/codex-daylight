import { readFile, writeFile, mkdir, copyFile, access, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Explicit public source list. New source files must be reviewed and added here. */
export const SOURCE_FILES = Object.freeze([
  '.gitattributes', '.gitignore', '.github/workflows/ci.yml', '.github/workflows/release.yml',
  'AGENTS.md', 'CHANGELOG.md', 'README.md', 'RELEASING.md', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'identity.mjs', 'client.mjs', 'client.test.mjs', 'core.mjs', 'core.test.mjs',
  'worker.mjs', 'worker.test.mjs', 'lifecycle.test.mjs', 'ui.ps1', 'launch.cmd', '启动Codex白昼.cmd',
  'scripts/release.ps1', 'scripts/release-core.mjs', 'scripts/release-core.test.mjs',
  'templates/node-LICENSE.txt',
]);

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/') || relative.includes(':') || relative.split('/').some(s => !s || s === '..' || s === '.')) throw new Error(`Unsafe archive path: ${relative}`);
  return relative;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP32, UTF-8 paths, fixed DOS date, sorted entries: identical input yields identical ZIP. */
export function zipBytes(entries) {
  const localParts = [], centralParts = [];
  let offset = 0, centralSize = 0;
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (sorted.length > 65535 || new Set(sorted.map(e => e.path)).size !== sorted.length) throw new Error('ZIP entries must be unique and fit ZIP32.');
  for (const entry of sorted) {
    const name = Buffer.from(safeRelative(entry.path), 'utf8');
    const bytes = Buffer.from(entry.bytes);
    const compressed = deflateRawSync(bytes, { level: 9 });
    if (bytes.length > 0xffffffff || compressed.length > 0xffffffff || name.length > 65535) throw new Error('ZIP32 size limit exceeded.');
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
    centralSize += central.length + name.length;
  }
  if (offset + centralSize > 0xffffffff) throw new Error('ZIP32 size limit exceeded.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function readSources(root) {
  const entries = [];
  for (const relative of SOURCE_FILES) {
    safeRelative(relative);
    const bytes = await readFile(path.join(root, relative));
    const text = bytes.toString('utf8');
    if (/[A-Za-z]:[\\/]Users[\\/](?!Public(?:[\\/]|$)|Default(?:[\\/]|$))[^\\/\s"']+[\\/]/i.test(text)) throw new Error(`Per-user absolute path found in public source: ${relative}`);
    entries.push({ path: relative, bytes });
  }
  return entries;
}

export function sourceManifest(entries) {
  return [...entries].map(e => ({ path: e.path, bytes: e.bytes.length, sha256: sha256(e.bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export const sourceDigest = entries => sha256(Buffer.from(JSON.stringify(sourceManifest(entries))));

async function writeNewOrIdentical(file, bytes, buildId) {
  let target = file;
  try {
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (sha256(await readFile(target)) === sha256(bytes)) return target;
    const ext = path.extname(file);
    target = `${file.slice(0, file.length - ext.length)}-${buildId}${ext}`;
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return target;
}

function validateCommit(root, commit, entries) {
  if (!commit) return null;
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('CommitRef must be a full 40-character Git commit SHA.');
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  let found;
  try { found = git(['rev-parse', '--verify', `${commit}^{commit}`]).toString().trim(); }
  catch { throw new Error('CommitRef is not a real commit available in this source checkout.'); }
  if (found.toLowerCase() !== commit.toLowerCase()) throw new Error('CommitRef verification failed.');
  for (const entry of entries) {
    let committed;
    try { committed = git(['show', `${commit}:${entry.path}`]); }
    catch { throw new Error(`Commit does not include source file: ${entry.path}`); }
    if (!committed.equals(entry.bytes)) throw new Error(`Working source differs from CommitRef: ${entry.path}`);
  }
  return commit.toLowerCase();
}

export async function verifySnapshot(snapshotDir) {
  const manifestBytes = await readFile(path.join(snapshotDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  for (const file of manifest.sourceFiles || []) {
    const bytes = await readFile(path.join(snapshotDir, 'source', safeRelative(file.path)));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Source checksum mismatch: ${file.path}`);
  }
  if (!Array.isArray(manifest.sourceFiles) || !manifest.sourceFiles.length) throw new Error('Snapshot has no source manifest.');
  for (const file of manifest.artifacts || []) {
    const bytes = await readFile(path.join(snapshotDir, 'artifacts', safeRelative(file.name)));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.name}`);
  }
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('Snapshot has no artifacts.');
  const actualDigest = sha256(Buffer.from(JSON.stringify(manifest.sourceFiles)));
  if (actualDigest !== manifest.sourceDigest) throw new Error('Source manifest digest mismatch.');
  const expected = new Map(manifest.artifacts.map(file => [file.name, file.sha256]));
  expected.set('manifest.json', sha256(manifestBytes));
  const sumLines = (await readFile(path.join(snapshotDir, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
  if (sumLines.length !== expected.size) throw new Error('Snapshot checksum list is incomplete.');
  for (const line of sumLines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || expected.get(match[2]) !== match[1]) throw new Error('Snapshot checksum list mismatch.');
    expected.delete(match[2]);
  }
  return { ok: true, version: manifest.version, sourceFiles: manifest.sourceFiles.length, artifacts: manifest.artifacts.length, sourceDigest: actualDigest };
}

export async function buildRelease({ root, outputDir, archiveDir, runtimePath, runtimeLicensePath, commitRef = '', sourceOnly = false }) {
  root = path.resolve(root);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/i.test(pkg.version)) throw new Error('package.json has no valid release version.');
  if (pkg.name !== 'codex-daylight') throw new Error('This release script only packages codex-daylight.');
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const escaped = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^##\\s+(?:\\[${escaped}\\]|${escaped})(?=\\s|$)`, 'm').test(changelog)) throw new Error('Add the current version to CHANGELOG.md before release.');
  const entries = await readSources(root);
  const commit = validateCommit(root, commitRef, entries);
  const digest = sourceDigest(entries);
  const createdAt = new Date().toISOString();
  const buildId = `${createdAt.replace(/[-:.TZ]/g, '')}-${digest.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  outputDir = path.resolve(outputDir || path.join(root, 'dist'));
  archiveDir = path.resolve(archiveDir || path.join(root, '版本归档'));
  await mkdir(outputDir, { recursive: true });
  const sourceZip = await writeNewOrIdentical(path.join(outputDir, `codex-daylight-${pkg.version}-source.zip`), zipBytes(entries), buildId);
  const artifacts = [{ name: path.basename(sourceZip), path: sourceZip, bytes: (await stat(sourceZip)).size, sha256: sha256(await readFile(sourceZip)) }];
  let portableZip = null, runtime = null;
  if (!sourceOnly) {
    if (!runtimePath || !runtimeLicensePath) throw new Error('Portable builds require runtime and complete Node.js license paths.');
    const runtimeIdentity = JSON.parse(execFileSync(runtimePath, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { windowsHide: true, encoding: 'utf8' }));
    const major = Number(/^v(\d+)\./.exec(runtimeIdentity.version)?.[1]);
    if (runtimeIdentity.platform !== 'win32' || runtimeIdentity.arch !== 'x64' || major < 22 || !Number.isFinite(major)) throw new Error('Portable runtime must be Windows x64 Node.js 22+.');
    const runtimeBytes = await readFile(runtimePath);
    const license = await readFile(runtimeLicensePath);
    if (!license.toString('utf8').includes('Node.js is licensed for use as follows:') || license.length < 100000) throw new Error('Node.js LICENSE including third-party notices is incomplete.');
    runtime = { ...runtimeIdentity, sha256: sha256(runtimeBytes), licenseSha256: sha256(license), licenseSource: `https://github.com/nodejs/node/blob/${runtimeIdentity.version}/LICENSE` };
    const notice = Buffer.from(`Node.js ${runtime.version} Windows x64\nLicense source: ${runtime.licenseSource}\nBinary SHA-256: ${runtime.sha256}\n`);
    const metadata = Buffer.from(`${JSON.stringify({ name: pkg.name, version: pkg.version, sourceDigest: digest, commitRef: commit, runtime, personalDataIncluded: false }, null, 2)}\n`);
    const portableEntries = entries.map(e => ({ path: `Codex-Daylight/${e.path}`, bytes: e.bytes }));
    portableEntries.push({ path: 'Codex-Daylight/runtime/node.exe', bytes: runtimeBytes }, { path: 'Codex-Daylight/runtime/LICENSE.txt', bytes: license }, { path: 'Codex-Daylight/runtime/SOURCE.txt', bytes: notice }, { path: 'Codex-Daylight/package-manifest.json', bytes: metadata });
    portableZip = await writeNewOrIdentical(path.join(outputDir, `codex-daylight-${pkg.version}-windows-x64.zip`), zipBytes(portableEntries), buildId);
    artifacts.push({ name: path.basename(portableZip), path: portableZip, bytes: (await stat(portableZip)).size, sha256: sha256(await readFile(portableZip)) });
  }
  const manifest = { name: pkg.name, version: pkg.version, preview: true, createdAt, commitRef: commit, sourceDigest: digest, sourceFiles: sourceManifest(entries), artifacts: artifacts.map(({ path: _path, ...f }) => f), runtime, personalDataIncluded: false };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = await writeNewOrIdentical(path.join(outputDir, 'manifest.json'), manifestBytes, buildId);
  const sums = artifacts.map(a => `${a.sha256}  ${a.name}`);
  sums.push(`${sha256(manifestBytes)}  ${path.basename(manifestPath)}`);
  const checksumBytes = Buffer.from(`${sums.join('\n')}\n`);
  const checksumsPath = await writeNewOrIdentical(path.join(outputDir, 'SHA256SUMS.txt'), checksumBytes, buildId);
  const versionRoot = path.join(archiveDir, `v${pkg.version}`);
  await mkdir(versionRoot, { recursive: true });
  const snapshotDir = path.join(versionRoot, buildId);
  await mkdir(snapshotDir);
  for (const entry of entries) {
    const target = path.join(snapshotDir, 'source', entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { flag: 'wx' });
  }
  await mkdir(path.join(snapshotDir, 'artifacts'));
  for (const artifact of artifacts) await copyFile(artifact.path, path.join(snapshotDir, 'artifacts', artifact.name));
  await writeFile(path.join(snapshotDir, 'manifest.json'), manifestBytes, { flag: 'wx' });
  const snapshotSums = artifacts.map(a => `${a.sha256}  ${a.name}`);
  snapshotSums.push(`${sha256(manifestBytes)}  manifest.json`);
  await writeFile(path.join(snapshotDir, 'SHA256SUMS.txt'), `${snapshotSums.join('\n')}\n`, { flag: 'wx' });
  await verifySnapshot(snapshotDir);
  return { version: pkg.version, sourceZip, portableZip, checksumsPath, manifestPath, snapshotDir, sourceDigest: digest };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv[2] === '--list-source') console.log(JSON.stringify(SOURCE_FILES));
    else if (process.argv[2] === '--verify') console.log(JSON.stringify(await verifySnapshot(path.resolve(process.argv[3]))));
    else {
      const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
      console.log(JSON.stringify(await buildRelease(options)));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
