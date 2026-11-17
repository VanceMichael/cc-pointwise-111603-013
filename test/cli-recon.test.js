import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();

function run(args, directory) {
  return spawnSync(process.execPath, ['src/cli.js', ...args], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, COLLECT_STATE_DIR: directory },
  });
}

test('帮助在保留原命令的同时列出对账扩展命令', () => {
  const result = run(['--help'], root);
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.deepEqual(help.commands, ['ingest', 'query']);
  assert.ok(help.extendedCommands.includes('reconcile'));
  assert.ok(help.usage.includes('ingest'));
});

test('名单、签到与确认分别落盘，确认后重提不同依据被拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-recon-'));
  try {
    const roster = run(['roster', 'fixtures/roster-import.json', '2026-11-16T08:05:00Z'], directory);
    assert.equal(roster.status, 0, roster.stderr);
    assert.equal(JSON.parse(roster.stdout).added, 3);

    const attendance = run(['attendance', 'fixtures/attendance.json'], directory);
    assert.equal(attendance.status, 0, attendance.stderr);
    assert.equal(JSON.parse(attendance.stdout).stored, 1);

    const confirm = run(['settlement', 'fixtures/settlements.json'], directory);
    assert.equal(confirm.status, 0, confirm.stderr);
    assert.equal(JSON.parse(confirm.stdout).confirmed[0].added, true);

    const tampered = join(directory, 'tampered.json');
    const basis = JSON.parse(await readFile(join(root, 'fixtures/settlements.json'), 'utf8'));
    basis[0].registrations = ['P1:R1', 'P1:R2'];
    await writeFile(tampered, JSON.stringify(basis));
    const rejected = run(['settlement', tampered], directory);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /already confirmed and cannot be rewritten/);

    const report = run(['report', 'hall-a', '2026-11-16T08:30:00Z'], directory);
    assert.equal(report.status, 0, report.stderr);
    const daily = JSON.parse(report.stdout);
    assert.equal(daily.sessions[0].counts.valid, 3);
    assert.equal(daily.sessions[0].counts.attendanceEvents, 1);

    const reconcile = run(['reconcile', 'hall-a', '2026-11-16T12:00:00Z'], directory);
    assert.equal(reconcile.status, 0, reconcile.stderr);
    const result = JSON.parse(reconcile.stdout);
    assert.deepEqual(result.confirmed.registrations, ['P1:R1']);
    assert.ok(Array.isArray(result.discrepancies));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('未知动作仍然显式失败并保留 ingest or query 提示', () => {
  const result = run(['invalid-action'], root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ingest or query/);
});
