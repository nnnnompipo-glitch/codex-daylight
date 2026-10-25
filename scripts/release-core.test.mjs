import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { zipBytes, sha256, sourceManifest, sourceDigest, verifySnapshot, readSources, SOURCE_FILES } from './release-core.mjs';

test('ZIP keeps dotfiles and Chinese paths with deterministic content and valid deflate data', () => {
  const files = [{ path: '启动.cmd', bytes: Buffer.from('hello') }, { path: '.github/workflows/ci.yml', bytes: Buffer.from('test') }];
  const first = zipBytes(files), second = zipBytes([...files].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt16LE(6), 0x0800);
  const compressedSize = first.readUInt32LE(18), nameSize = first.readUInt16LE(26);
  const firstName = first.subarray(30, 30 + nameSize).toString();
  assert.equal(firstName, '.github/workflows/ci.yml');
  assert.equal(inflateRawSync(first.subarray(30 + nameSize, 30 + nameSize + compressedSize)).toString(), 'test');
  assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
});

test('ZIP rejects traversal, absolute paths and duplicate entries', () => {
  for (const relative of ['../secret', '/absolute', 'a/../b', 'a\\b', 'C:/private']) assert.throws(() => zipBytes([{ path: relative, bytes: Buffer.from('x') }]), /Unsafe/);
  assert.throws(() => zipBytes([{ path: 'a', bytes: Buffer.from('x') }, { path: 'a', bytes: Buffer.from('y') }]), /unique/);
});

test('source allowlist excludes runtime state and snapshot verification detects tampering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'daylight-release-test-'));
  try {
    for (const file of SOURCE_FILES) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), `source ${file}`);
    }
    await writeFile(path.join(dir, 'auth.json'), 'fixture-private');
    const entries = await readSources(dir);
    assert.equal(entries.length, SOURCE_FILES.length);
    assert.equal(entries.some(e => e.path === 'auth.json'), false);
    const selected = [entries[0]];
    await mkdir(path.dirname(path.join(dir, 'snapshot/source', selected[0].path)), { recursive: true });
    await writeFile(path.join(dir, 'snapshot/source', selected[0].path), selected[0].bytes);
    await mkdir(path.join(dir, 'snapshot/artifacts'));
    const artifact = Buffer.from('archive');
    await writeFile(path.join(dir, 'snapshot/artifacts/source.zip'), artifact);
    const manifest = { version: '0.1.0', sourceFiles: sourceManifest(selected), sourceDigest: sourceDigest(selected), artifacts: [{ name: 'source.zip', bytes: artifact.length, sha256: sha256(artifact) }] };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path.join(dir, 'snapshot/manifest.json'), manifestBytes);
    await writeFile(path.join(dir, 'snapshot/SHA256SUMS.txt'), `${sha256(artifact)}  source.zip\n${sha256(manifestBytes)}  manifest.json\n`);
    assert.equal((await verifySnapshot(path.join(dir, 'snapshot'))).ok, true);
    await writeFile(path.join(dir, 'snapshot/source', selected[0].path), 'changed');
    await assert.rejects(verifySnapshot(path.join(dir, 'snapshot')), /checksum mismatch/);
  } finally {
    const target = path.resolve(dir), intendedParent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(target), intendedParent);
    assert.ok(path.basename(target).startsWith('daylight-release-test-'));
    await rm(target, { recursive: true, force: true });
  }
});

test('per-user absolute paths cannot enter the public source export', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'daylight-private-test-'));
  try {
    await writeFile(path.join(dir, SOURCE_FILES[0]), ['C:', 'Users', 'personal', 'auth.json'].join('\\'));
    await assert.rejects(readSources(dir), /Per-user absolute path/);
  } finally {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('daylight-private-test-'));
    await rm(target, { recursive: true, force: true });
  }
});
