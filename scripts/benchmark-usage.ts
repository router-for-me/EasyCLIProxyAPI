import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src-tauri/src/usage.rs', import.meta.url), 'utf8');
function sqlForFunction(name: string) {
  const start = source.indexOf('fn ' + name + '(');
  if (start < 0) throw new Error('Missing function: ' + name);
  const remaining = source.slice(start);
  const next = remaining.indexOf('\nfn ', 1);
  return [...remaining.slice(0, next < 0 ? undefined : next).matchAll(/r#"([\s\S]*?)"#/g)]
    .map((match) => match[1]!);
}

const database = new Database(':memory:');
database.exec(sqlForFunction('initialize_usage_schema')[0]!);
database.exec('CREATE INDEX idx_usage_events_canceled_timestamp ON usage_events(canceled, timestamp_ms DESC)');
const filter = ' WHERE timestamp_ms >= 0 AND timestamp_ms <= 1000000000000';
const expand = (sql: string) => sql.replaceAll('{}', filter)
  .replaceAll('{LONG_CONTEXT_INPUT_TOKEN_THRESHOLD}', '272000');
const categorySql = sqlForFunction('load_simple_categories')[0]!;
const previousCategories = ['model', 'provider', 'source'].map((column) => ({
  statement: database.query(expand(categorySql.replaceAll('{column}', column))), args: ['unknown'],
}));
previousCategories.push({
  statement: database.query(expand(sqlForFunction('load_api_key_categories')[0]!)), args: [],
});
const overview = [
  sqlForFunction('load_usage_overview')[0]!,
  sqlForFunction('load_usage_cost_groups')[0]!,
  sqlForFunction('load_usage_overview')[1]!,
].map((sql) => ({ statement: database.query(expand(sql)), args: [] as string[] }));
const previous = [...previousCategories, ...overview, ...previousCategories];
const optimized = [
  { statement: database.query(expand(sqlForFunction('load_usage_analysis')[0]!)), args: [] },
  ...overview,
];
const medianMs = (queries: typeof previous) => {
  const samples = Array.from({ length: 4 }, () => {
    const start = performance.now();
    for (const query of queries) query.statement.all(...query.args);
    return performance.now() - start;
  }).slice(1).sort((left, right) => left - right);
  return Math.round(samples[1]!);
};

const insert = database.query('INSERT INTO usage_events(event_key,timestamp,timestamp_ms,local_hour,model,provider,source,api_key_hash,latency_ms,ttft_ms,input_tokens,output_tokens,total_tokens,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3000, 1000, 1000, 200, 1200, ?)');
const timestamp = '2026-09-05T00:00:00Z';
let inserted = 0;
console.log('Synthetic in-memory SQLite; repository schema/indexes/SQL; all rows match; SQL only, excluding Rust folding, IPC and rendering.');
for (const size of [10_000, 100_000, 300_000]) {
  database.transaction(() => {
    while (inserted < size) {
      inserted += 1;
      insert.run('event-' + inserted, timestamp, inserted, '2026-09-05-' + inserted % 24,
        'model-' + inserted % 20, 'provider-' + inserted % 5, 'source-' + inserted % 100,
        'key-' + inserted % 30, timestamp);
    }
  })();
  console.log(JSON.stringify({ records: size,
    before: { queries: previous.length, medianMs: medianMs(previous) },
    after: { queries: optimized.length, medianMs: medianMs(optimized) },
  }));
}
database.close();
