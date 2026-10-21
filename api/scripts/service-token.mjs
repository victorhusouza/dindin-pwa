// Gerencia tokens de servico da API dindin (acesso de IAs, ex.: "Instinct WhatsApp").
// Uso:
//   node scripts/service-token.mjs create "<nome>" <escopos> [validade-dias]
//     ex.: node scripts/service-token.mjs create "Instinct WhatsApp" tx:create
//     ex.: node scripts/service-token.mjs create "Leitor" read 30
//   node scripts/service-token.mjs list
//   node scripts/service-token.mjs revoke "<nome>"
// Escopos: read | tx:create | tx:edit | tx:delete (separar por virgula).
// O token completo so aparece UMA vez, na criacao. No banco fica so o hash.
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const db = new Database(path.join(DATA_DIR, 'dindin.db'));
db.exec('CREATE TABLE IF NOT EXISTS service_tokens (token_hash TEXT PRIMARY KEY, label TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER)');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const VALID = new Set(['read', 'tx:create', 'tx:edit', 'tx:delete']);
const [cmd, label, scopesArg, daysArg] = process.argv.slice(2);

if (cmd === 'create') {
    const scopes = String(scopesArg || '').split(',').filter(Boolean);
    if (!label || !scopes.length || scopes.some((s) => !VALID.has(s))) {
        console.error('uso: create "<nome>" <escopos: read,tx:create,tx:edit,tx:delete> [validade-dias]');
        process.exit(1);
    }
    const days = Number(daysArg) || 0;
    const token = 'dindin_svc_' + crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO service_tokens (token_hash, label, scopes, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(sha256(token), label.slice(0, 80), scopes.join(','), Date.now(), days ? Date.now() + days * 86400000 : null);
    console.log(`Token criado para "${label}" (${scopes.join(', ')}${days ? `, vale ${days} dias` : ', sem validade'}). Ele NAO aparece de novo:`);
    console.log(token);
} else if (cmd === 'list') {
    for (const r of db.prepare('SELECT label, scopes, created_at, expires_at FROM service_tokens').all())
        console.log(`${r.label} [${r.scopes}] criado ${new Date(r.created_at).toISOString().slice(0, 10)}${r.expires_at ? ', vence ' + new Date(r.expires_at).toISOString().slice(0, 10) : ', sem validade'}`);
} else if (cmd === 'revoke') {
    if (!label) { console.error('uso: revoke "<nome>"'); process.exit(1); }
    const n = db.prepare('DELETE FROM service_tokens WHERE label = ?').run(label).changes;
    console.log(n ? 'Revogado: ' + label : 'Nenhum token com esse nome.');
} else {
    console.error('comandos: create <nome> <escopos> [dias] | list | revoke <nome>');
    process.exit(1);
}
