import { Database } from 'bun:sqlite'

const db = new Database('litellm-proxy.db')
db.run('PRAGMA journal_mode = WAL')
db.run('PRAGMA synchronous = NORMAL')

db.run(`CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider TEXT PRIMARY KEY,
  cooldown_until INTEGER NOT NULL,
  consecutive_failures INTEGER DEFAULT 0
)`)

db.run(`CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  timestamp INTEGER DEFAULT (unixepoch())
)`)

const getCooldown = db.query('SELECT cooldown_until FROM provider_cooldowns WHERE provider = ?')
const upsertCooldown = db.query(`
  INSERT INTO provider_cooldowns (provider, cooldown_until, consecutive_failures)
  VALUES (?, ?, 1)
  ON CONFLICT(provider) DO UPDATE SET
    cooldown_until = excluded.cooldown_until,
    consecutive_failures = consecutive_failures + 1
`)
const resetCooldown = db.query(`
  UPDATE provider_cooldowns SET consecutive_failures = 0 WHERE provider = ?
`)
const insertLog = db.query(`
  INSERT INTO request_log (model, provider, status, latency_ms)
  VALUES ($model, $provider, $status, $latency_ms)
`)

export function isOnCooldown(provider: string): boolean {
  const row = getCooldown.get(provider) as { cooldown_until: number } | null
  return row !== null && row.cooldown_until > Date.now()
}

export function markCooldown(provider: string, ms: number): void {
  upsertCooldown.run(provider, Date.now() + ms)
}

export function logRequest(params: { model: string; provider: string; status: number; latency_ms: number }): void {
  try {
    insertLog.run(params)
  } catch {
    // Fire-and-forget — don't fail the request
  }
}

export function getMetrics(): any {
  return db.query(`
    SELECT provider, COUNT(*) as requests, AVG(latency_ms) as avg_latency,
           SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors
    FROM request_log
    WHERE timestamp > unixepoch() - 3600
    GROUP BY provider
  `).all()
}
