import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { RosterStore } from './roster-store.js';
import { AttendanceStore } from './attendance-store.js';
import { SettlementStore } from './settlement-store.js';
import { buildDailyReport, reconcileSettlement } from './reconciliation.js';
import { collectRoster } from './collector.js';
import { SourceClient } from './source-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, '..');
const stateDirectory = process.env.COLLECT_STATE_DIR
  ? resolve(process.env.COLLECT_STATE_DIR)
  : resolve(defaultRoot, 'var');

export function createStores(root = stateDirectory) {
  return {
    legacy: new RecordRepository(resolve(root, 'records.json')),
    roster: new RosterStore(resolve(root, 'roster.json')),
    attendance: new AttendanceStore(resolve(root, 'attendance.json')),
    settlements: new SettlementStore(resolve(root, 'settlements.json')),
  };
}

const baseCommands = ['ingest', 'query'];
const extendedCommands = ['roster', 'attendance', 'settlement', 'report', 'reconcile', 'collect'];

function help() {
  return {
    usage: 'npm start -- ingest [文件] | query [来源] | roster [文件] | attendance [文件] | settlement [文件] | report [场次] [时点] | reconcile [文件/场次] [时点] | collect 来源URL [合作方..]',
    commands: baseCommands,
    extendedCommands,
    stateDirectory,
    note: '名单修订与签到分文件留痕；缺席不等于撤回，status=cancelled 才撤回；结算确认不可变',
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runCli(argv = process.argv.slice(2), stores = createStores()) {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === '-h') {
    return help();
  }
  if (action === 'ingest') {
    const records = await readJson(rest[0] ?? resolve(defaultRoot, 'fixtures/records.json'));
    return new CollectionService(stores.legacy).ingest(records);
  }
  if (action === 'query') {
    return new CollectionService(stores.legacy).query({ source: rest[0] });
  }
  if (action === 'roster') {
    const payload = await readJson(rest[0] ?? resolve(defaultRoot, 'fixtures/roster-import.json'));
    const records = Array.isArray(payload) ? payload : payload.records;
    if (!Array.isArray(records)) throw new Error('roster input must be an array or contain records array');
    const observedAt = rest[1] ?? new Date().toISOString();
    return stores.roster.appendObservations(records, {
      batchId: `import-${observedAt.replace(/[:.]/g, '-')}`,
      path: rest[0] ?? 'fixture', observedAt,
    });
  }
  if (action === 'attendance') {
    const events = await readJson(rest[0] ?? resolve(defaultRoot, 'fixtures/attendance.json'));
    return stores.attendance.merge(events);
  }
  if (action === 'settlement') {
    const payload = await readJson(rest[0] ?? resolve(defaultRoot, 'fixtures/settlements.json'));
    const confirmations = Array.isArray(payload) ? payload : [payload];
    const results = [];
    for (const confirmation of confirmations) {
      results.push(await stores.settlements.confirm(confirmation));
    }
    return { confirmed: results };
  }
  if (action === 'report') {
    const session = rest[0] || null;
    const asOf = rest[1] ?? new Date().toISOString();
    const [roster, attendance] = await Promise.all([stores.roster.load(), stores.attendance.load()]);
    return buildDailyReport(roster, attendance, asOf, session);
  }
  if (action === 'reconcile') {
    const asOf = rest[1] ?? new Date().toISOString();
    const [roster, attendance] = await Promise.all([stores.roster.load(), stores.attendance.load()]);
    let confirmation;
    if (rest[0] && rest[0].includes('/')) {
      const payload = await readJson(rest[0]);
      confirmation = Array.isArray(payload) ? payload[0] : payload;
    } else {
      const session = rest[0];
      const document = await stores.settlements.load();
      confirmation = document.confirmations
        .filter((item) => !session || item.session === session)
        .at(-1);
      if (!confirmation) throw new Error(`no confirmed settlement found${session ? ` for ${session}` : ''}`);
    }
    return reconcileSettlement(roster, attendance, confirmation, asOf);
  }
  if (action === 'collect') {
    const [sourceUrl, ...partners] = rest;
    if (!sourceUrl) throw new Error('collect requires a source url');
    const client = new SourceClient(sourceUrl);
    return collectRoster(client, stores.roster, { partners: partners.length ? partners : ['P1', 'P2'] });
  }
  throw new Error('action must be ingest or query (or one of: roster, attendance, settlement, report, reconcile, collect)');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const output = await runCli();
  console.log(JSON.stringify(output, null, 2));
}
