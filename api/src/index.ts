// dindin API: login multiusuario (convite em fase posterior), sync offline-first e historico.
// Isolamento: toda rota de dados filtra por owner = usuario da sessao/token (T2).
// Sem framework: node:http + better-sqlite3. Roda em 127.0.0.1 atras do Caddy.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { capFirst } from './format.js';

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;       // sessao deslizante: 7 dias
const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;      // teto absoluto: 30 dias
const LOCK_FAILS = 5;                              // tentativas antes do bloqueio
const LOCK_MS = 15 * 60 * 1000;                    // bloqueio de 15 minutos
const MAX_BODY = 1024 * 1024;                      // 1 MB por requisicao
const APP_URL = process.env.APP_URL || ''; // URL publica do app (obrigatoria pra montar o link do convite)
const INVITE_TTL_MS = 3 * 24 * 3600 * 1000;           // convite vale 3 dias
const ENTITIES = new Set(['tx', 'cat', 'rec', 'catrule', 'pref']);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'dindin.db'));
db.pragma('journal_mode = WAL');

// migracao v2 (multiusuario): uma vez, na subida, se o banco for do formato antigo.
// Idempotente: banco ja migrado (records tem coluna owner) ou zerado sai ileso.
function migrateIfNeeded(): void {
    const hasRecords = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get();
    if (!hasRecords) return; // banco novo: o CREATE TABLE abaixo ja nasce no formato v2
    const cols = db.prepare('PRAGMA table_info(records)').all() as any[];
    if (cols.some(c => c.name === 'owner')) return; // ja migrado
    db.pragma('foreign_keys = OFF');
    db.exec(`
BEGIN;
CREATE TABLE users_new (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
INSERT INTO users_new (id, username, pass_hash, created_at, is_admin, active) SELECT id, username, pass_hash, created_at, 1, 1 FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE TABLE records_new (entity TEXT NOT NULL, id TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 1 REFERENCES users(id), updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY (entity, id, owner));
INSERT INTO records_new SELECT entity, id, 1, updated_at, deleted, data FROM records;
DROP TABLE records;
ALTER TABLE records_new RENAME TO records;
CREATE INDEX idx_records_owner ON records(owner, entity);
CREATE TABLE history_new (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '', entity TEXT NOT NULL, rid TEXT NOT NULL, op TEXT NOT NULL, before TEXT, after TEXT, owner INTEGER NOT NULL DEFAULT 1 REFERENCES users(id));
INSERT INTO history_new SELECT seq, ts, device, entity, rid, op, before, after, 1 FROM history;
DROP TABLE history;
ALTER TABLE history_new RENAME TO history;
CREATE TABLE sessions_new (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id));
INSERT INTO sessions_new SELECT token_hash, created_at, expires_at, device, 1 FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE TABLE service_tokens_new (token_hash TEXT PRIMARY KEY, label TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id));
INSERT INTO service_tokens_new SELECT token_hash, label, scopes, created_at, expires_at, last_used_at, 1 FROM service_tokens;
DROP TABLE service_tokens;
ALTER TABLE service_tokens_new RENAME TO service_tokens;
CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
PRAGMA foreign_key_check;
COMMIT;
`);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_v', '2');
    console.log('migracao v2 (multiusuario) aplicada');
}
migrateIfNeeded();

db.exec(`
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS records (entity TEXT NOT NULL, id TEXT NOT NULL, owner INTEGER NOT NULL REFERENCES users(id), updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY (entity, id, owner));
CREATE INDEX IF NOT EXISTS idx_records_owner ON records(owner, entity);
CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '', entity TEXT NOT NULL, rid TEXT NOT NULL, op TEXT NOT NULL, before TEXT, after TEXT, owner INTEGER NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS fails (k TEXT PRIMARY KEY, n INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS service_tokens (token_hash TEXT PRIMARY KEY, label TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, user_id INTEGER NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
`);
db.pragma('foreign_keys = ON');

// ---------- categorias ----------
// Nome normalizado: mesma regra do app (sem acento, minusculo, espacos aparados).
const normLabel = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// Migracao v3: tabela de categorias com unicidade por (dono, tipo, nome normalizado).
// ADITIVA: copia de records e nao apaga nada — os registros antigos ficam intactos
// no banco como backup frio (rollback = voltar o codigo, sem restaurar arquivo).
function migrateCatsIfNeeded(): void {
    const v = db.prepare("SELECT v FROM meta WHERE k = 'schema_v'").get() as any;
    if (v && Number(v.v) >= 3) return;
    db.exec(`CREATE TABLE IF NOT EXISTS categories (
        owner INTEGER NOT NULL REFERENCES users(id),
        id TEXT NOT NULL,
        label TEXT NOT NULL,
        norm_label TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'ambos',
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, id)
    )`);
    const rows = db.prepare("SELECT owner, id, updated_at, deleted, data FROM records WHERE entity = 'cat'").all() as any[];
    // Etapa 0: se houver duplicata por (dono, tipo, nome) entre ATIVAS, ABORTA o boot
    // e lista os grupos — merge so com decisao humana, nunca automatico.
    const groups = new Map<string, string[]>();
    for (const r of rows) {
        if (r.deleted) continue;
        const d = JSON.parse(r.data);
        const key = [r.owner, d.type || 'ambos', normLabel(d.label)].join('|');
        const g = groups.get(key) || []; g.push(r.id); groups.set(key, g);
    }
    const dupes = [...groups.entries()].filter(([, ids]) => ids.length > 1);
    if (dupes.length) {
        console.error('MIGRACAO v3 ABORTADA - categorias duplicadas por (dono|tipo|nome):');
        for (const [k, ids] of dupes) console.error('  ' + k + ' -> ' + ids.join(', '));
        throw new Error('migracao v3 abortada: resolver duplicatas de categorias antes');
    }
    const ins = db.prepare('INSERT INTO categories (owner, id, label, norm_label, icon, color, type, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?)');
    const txm = db.transaction((list: any[]) => {
        for (const r of list) {
            const d = JSON.parse(r.data);
            ins.run(r.owner, r.id, String(d.label || r.id), normLabel(d.label), String(d.icon || ''), String(d.color || ''), String(d.type || 'ambos'), r.updated_at, r.deleted);
        }
    });
    txm(rows);
    // Indice unico parcial: so vale para categorias ativas (apagadas nao bloqueiam reutilizar o nome).
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS categories_uniq ON categories(owner, type, norm_label) WHERE deleted = 0');
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_v', '3')").run();
    console.log('migracao v3 (tabela categories: ' + rows.length + ' copiadas, registros antigos mantidos) aplicada');
}
migrateCatsIfNeeded();

// Migracao v4: lancamentos ganham tabela propria (transactions), com colunas de
// verdade e chave estrangeira para a categoria. ADITIVA como a v3: copia de
// records e nao apaga nada — os registros antigos ficam intactos (copia fria).
// Etapa 0: qualquer problema (registro invalido, campo desconhecido ou categoria
// orfa) ABORTA o boot e lista um a um — correcao so com decisao humana.
const TX_KEYS = new Set(['id', 'date', 'desc', 'cat', 'cents', 'type', 'recKey', 'fitid']);
function migrateTxsIfNeeded(): void {
    const v = db.prepare("SELECT v FROM meta WHERE k = 'schema_v'").get() as any;
    if (v && Number(v.v) >= 4) return;
    db.exec(`CREATE TABLE IF NOT EXISTS transactions (
        owner INTEGER NOT NULL REFERENCES users(id),
        id TEXT NOT NULL,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        cat TEXT NOT NULL,
        cents INTEGER NOT NULL,
        type TEXT NOT NULL,
        rec_key TEXT,
        fitid TEXT,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, id),
        FOREIGN KEY (owner, cat) REFERENCES categories(owner, id)
    )`);
    const rows = db.prepare("SELECT owner, id, updated_at, deleted, data FROM records WHERE entity = 'tx'").all() as any[];
    const catExists = db.prepare('SELECT 1 FROM categories WHERE owner = ? AND id = ?');
    const problems: string[] = [];
    for (const r of rows) {
        let d: any = null;
        try { d = JSON.parse(r.data); } catch { /* cai no invalido abaixo */ }
        if (!d || typeof d !== 'object' || !validNewTx(d) || d.id !== r.id) {
            problems.push('dono=' + r.owner + ' id=' + r.id + ' apagado=' + (r.deleted ? 'sim' : 'nao') + ' motivo=registro invalido (' + String(r.data).slice(0, 80) + ')');
            continue;
        }
        const extra = Object.keys(d).filter(k => !TX_KEYS.has(k));
        if (extra.length) {
            problems.push('dono=' + r.owner + ' id=' + r.id + ' motivo=campos desconhecidos: ' + extra.join(', ') + ' (a tabela nova nao teria onde guarda-los)');
            continue;
        }
        if (!catExists.get(r.owner, String(d.cat))) {
            problems.push('dono=' + r.owner + ' id=' + r.id + ' data=' + d.date + ' desc="' + d.desc + '" apagado=' + (r.deleted ? 'sim' : 'nao') + ' motivo=categoria orfa "' + d.cat + '"');
        }
    }
    if (problems.length) {
        console.error('MIGRACAO v4 ABORTADA - ' + problems.length + ' lancamento(s) com problema:');
        for (const p of problems) console.error('  ' + p);
        throw new Error('migracao v4 abortada: resolver os lancamentos listados acima antes');
    }
    const ins = db.prepare('INSERT INTO transactions (owner, id, date, description, cat, cents, type, rec_key, fitid, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const txm = db.transaction((list: any[]) => {
        for (const r of list) {
            const d = JSON.parse(r.data);
            ins.run(r.owner, r.id, String(d.date), String(d.desc), String(d.cat), d.cents, d.type, d.recKey ? String(d.recKey) : null, d.fitid ? String(d.fitid) : null, r.updated_at, r.deleted);
        }
    });
    txm(rows);
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_v', '4')").run();
    console.log('migracao v4 (tabela transactions: ' + rows.length + ' copiados, registros antigos mantidos) aplicada');
}
migrateTxsIfNeeded();

// Migracao v5: contas fixas ganham tabela propria (recs), no mesmo ritual da v4:
// aditiva (copia de records, originais intactos como copia fria), etapa 0 aborta
// o boot listando um a um registro invalido, campo desconhecido ou categoria orfa.
// Conta fixa e sempre despesa no app, entao nao tem coluna de tipo.
const REC_KEYS = new Set(['id', 'desc', 'cat', 'cents', 'dueDay']);
function migrateRecsIfNeeded(): void {
    const v = db.prepare("SELECT v FROM meta WHERE k = 'schema_v'").get() as any;
    if (v && Number(v.v) >= 5) return;
    db.exec(`CREATE TABLE IF NOT EXISTS recs (
        owner INTEGER NOT NULL REFERENCES users(id),
        id TEXT NOT NULL,
        description TEXT NOT NULL,
        cat TEXT NOT NULL,
        cents INTEGER NOT NULL,
        due_day INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, id),
        FOREIGN KEY (owner, cat) REFERENCES categories(owner, id)
    )`);
    const rows = db.prepare("SELECT owner, id, updated_at, deleted, data FROM records WHERE entity = 'rec'").all() as any[];
    const catExists = db.prepare('SELECT 1 FROM categories WHERE owner = ? AND id = ?');
    const problems: string[] = [];
    for (const r of rows) {
        let d: any = null;
        try { d = JSON.parse(r.data); } catch { /* cai no invalido abaixo */ }
        if (!d || typeof d !== 'object' || !validNewRec(d) || d.id !== r.id) {
            problems.push('dono=' + r.owner + ' id=' + r.id + ' apagado=' + (r.deleted ? 'sim' : 'nao') + ' motivo=registro invalido (' + String(r.data).slice(0, 80) + ')');
            continue;
        }
        const extra = Object.keys(d).filter(k => !REC_KEYS.has(k));
        if (extra.length) {
            problems.push('dono=' + r.owner + ' id=' + r.id + ' motivo=campos desconhecidos: ' + extra.join(', ') + ' (a tabela nova nao teria onde guarda-los)');
            continue;
        }
        if (!catExists.get(r.owner, String(d.cat))) {
            problems.push('dono=' + r.owner + ' id=' + r.id + ' desc="' + d.desc + '" apagado=' + (r.deleted ? 'sim' : 'nao') + ' motivo=categoria orfa "' + d.cat + '"');
        }
    }
    if (problems.length) {
        console.error('MIGRACAO v5 ABORTADA - ' + problems.length + ' conta(s) fixa(s) com problema:');
        for (const p of problems) console.error('  ' + p);
        throw new Error('migracao v5 abortada: resolver as contas fixas listadas acima antes');
    }
    const ins = db.prepare('INSERT INTO recs (owner, id, description, cat, cents, due_day, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?)');
    const txm = db.transaction((list: any[]) => {
        for (const r of list) {
            const d = JSON.parse(r.data);
            ins.run(r.owner, r.id, String(d.desc), String(d.cat), d.cents, d.dueDay, r.updated_at, r.deleted);
        }
    });
    txm(rows);
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_v', '5')").run();
    console.log('migracao v5 (tabela recs: ' + rows.length + ' copiadas, registros antigos mantidos) aplicada');
}
migrateRecsIfNeeded();

// ---------- senha (scrypt) ----------
function hashPassword(pw: string): string {
    const salt = crypto.randomBytes(16);
    const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw: string, stored: string): boolean {
    try {
        const [algo, N, r, p, saltB64, hashB64] = stored.split('$');
        if (algo !== 'scrypt') return false;
        const salt = Buffer.from(saltB64, 'base64');
        const expect = Buffer.from(hashB64, 'base64');
        const h = crypto.scryptSync(pw, salt, expect.length, { N: Number(N), r: Number(r), p: Number(p) });
        return crypto.timingSafeEqual(h, expect);
    } catch { return false; }
}
// hash falso para equalizar tempo quando nao existe usuario
const DUMMY_HASH = hashPassword('senha-falsa-so-para-timing');

const UN_RE = /^[a-z0-9._-]{3,30}$/;
function usernameIssues(u: string): string | null {
    if (!UN_RE.test(u)) return 'Usuário: 3 a 30 caracteres (letras minúsculas, números, ponto, hífen ou _).';
    return null;
}
const normUser = (u: unknown): string => String(u ?? '').trim().toLowerCase();

function passwordIssues(pw: unknown): string | null {
    if (typeof pw !== 'string') return 'Senha inválida.';
    if (pw.length < 10) return 'Use pelo menos 10 caracteres.';
    if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Misture letras e números.';
    return null;
}

// ---------- sessoes ----------
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
function createSession(device: string, userId: number): { token: string; expires: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at, device, user_id) VALUES (?,?,?,?,?)')
        .run(sha256(token), now, now + SESSION_TTL_MS, device.slice(0, 80), userId);
    return { token, expires: now + SESSION_TTL_MS };
}
function sessionFromCookie(req: http.IncomingMessage): { token: string; device: string; userId: number; username: string; isAdmin: boolean } | null {
    const raw = req.headers.cookie || '';
    const m = /(?:^|;\s*)dindin_s=([A-Za-z0-9_-]+)/.exec(raw);
    if (!m) return null;
    const token = m[1];
    const row = db.prepare('SELECT s.created_at, s.expires_at, s.device, s.user_id, u.active, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha256(token)) as any;
    if (!row) return null;
    if (!row.active) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); return null; } // usuario desativado: sessao morre aqui
    const now = Date.now();
    if (now > row.expires_at || now > row.created_at + SESSION_MAX_MS) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
        return null;
    }
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL_MS, sha256(token)); // deslizante
    return { token, device: row.device, userId: row.user_id, username: row.username, isAdmin: !!row.is_admin };
}
function cookieHeader(token: string, maxAgeSec: number): string {
    return `dindin_s=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

// ---------- tokens de servico (acesso de IAs/assistentes como feature) ----------
// Bearer no header Authorization. Escopos por permissao (ex.: tx:create),
// validade opcional (expires_at NULL = sem prazo), revogavel apagando a linha.
// O nome do token vira o "device" no historico de alteracoes.
// Escopos previstos: read | tx:create | tx:edit | tx:delete (sessao de login pode tudo).
interface Auth { kind: 'session' | 'service'; device: string; scopes?: Set<string>; userId: number }
const VALID_SCOPES = new Set(['read', 'tx:create', 'tx:edit', 'tx:delete']);
const touchLastUsed = db.prepare('UPDATE service_tokens SET last_used_at = ? WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < ?)');
function serviceFromHeader(req: http.IncomingMessage): Auth | null {
    const m = /^Bearer (dindin_svc_[A-Za-z0-9_-]{20,80})$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const hash = sha256(m[1]);
    const row = db.prepare('SELECT t.label, t.scopes, t.expires_at, t.user_id, u.active FROM service_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?').get(hash) as any;
    if (!row) return null;
    if (!row.active) return null; // dono desativado: token morre aqui
    if (row.expires_at && Date.now() > row.expires_at) return null; // vencido: trata como inexistente
    touchLastUsed.run(Date.now(), hash, Date.now() - 60000);
    return { kind: 'service', device: row.label, scopes: new Set(String(row.scopes).split(',')), userId: row.user_id };
}
function validNewTx(data: any): boolean {
    return data && typeof data === 'object' && !Array.isArray(data)
        && typeof data.id === 'string' && !!data.id
        && /^\d{4}-\d{2}-\d{2}$/.test(String(data.date))
        && typeof data.desc === 'string' && !!data.desc.trim()
        && typeof data.cat === 'string' && !!data.cat
        && Number.isInteger(data.cents) && data.cents > 0
        && (data.type === 'despesa' || data.type === 'receita');
}

function validNewRec(data: any): boolean {
    return data && typeof data === 'object' && !Array.isArray(data)
        && typeof data.id === 'string' && !!data.id
        && typeof data.desc === 'string' && !!data.desc.trim()
        && typeof data.cat === 'string' && !!data.cat
        && Number.isInteger(data.cents) && data.cents > 0
        && Number.isInteger(data.dueDay) && data.dueDay >= 1 && data.dueDay <= 31;
}

// ---------- bloqueio por tentativas ----------
function lockInfo(key: string): { locked: boolean; waitSec: number } {
    const row = db.prepare('SELECT n, locked_until FROM fails WHERE k = ?').get(key) as any;
    if (!row) return { locked: false, waitSec: 0 };
    const now = Date.now();
    if (row.locked_until > now) return { locked: true, waitSec: Math.ceil((row.locked_until - now) / 1000) };
    return { locked: false, waitSec: 0 };
}
function noteFail(key: string): void {
    const now = Date.now();
    const row = db.prepare('SELECT n, locked_until FROM fails WHERE k = ?').get(key) as any;
    let n = (row?.n || 0) + 1;
    if (row && row.locked_until > 0 && row.locked_until <= now) n = 1; // bloqueio expirou: recomeca
    const lockedUntil = n >= LOCK_FAILS ? now + LOCK_MS : 0;
    if (n >= LOCK_FAILS) n = 0; // zera o contador para o proximo ciclo
    db.prepare('INSERT INTO fails (k, n, locked_until) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n=excluded.n, locked_until=excluded.locked_until')
        .run(key, n, lockedUntil);
}
function clearFails(key: string): void { db.prepare('DELETE FROM fails WHERE k = ?').run(key); }

// ---------- helpers HTTP ----------
function send(res: http.ServerResponse, code: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extraHeaders,
    });
    res.end(payload);
}
function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('body grande demais')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('JSON inválido')); }
        });
        req.on('error', reject);
    });
}
const hasUser = () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
const clientIp = (req: http.IncomingMessage) => (req.headers['x-forwarded-for'] as string || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

// ---------- sync ----------
interface SyncOp { entity: string; id: string; op: string; data?: unknown; ts?: number; }
function applyOps(device: string, userId: number, ops: SyncOp[]): { applied: number; results: any[] } {
    const results: any[] = [];
    let applied = 0;
    const getRec = db.prepare('SELECT updated_at, deleted, data FROM records WHERE entity = ? AND id = ? AND owner = ?');
    const upRec = db.prepare(`INSERT INTO records (entity, id, owner, updated_at, deleted, data) VALUES (@entity,@id,@owner,@updated_at,@deleted,@data)
        ON CONFLICT(entity,id,owner) DO UPDATE SET updated_at=excluded.updated_at, deleted=excluded.deleted, data=excluded.data`);
    const addHist = db.prepare('INSERT INTO history (ts, device, entity, rid, op, before, after, owner) VALUES (?,?,?,?,?,?,?,?)');
    const tx = db.transaction((list: SyncOp[]) => {
        // Categorias primeiro: lancamentos e contas fixas dependem dela (chave
        // estrangeira), entao se o mesmo lote cria a categoria e quem a usa, a
        // categoria ja existe. A ordem entre ops da mesma entidade se mantem; o
        // app le results por status/id (nao por posicao) e o caminho de token e
        // so de lancamentos (ordem identica), entao reordenar aqui e seguro.
        const ordered = [...list].sort((a, b) => (a?.entity === 'cat' ? 0 : 1) - (b?.entity === 'cat' ? 0 : 1));
        for (const o of ordered) {
            if (!ENTITIES.has(o.entity) || typeof o.id !== 'string' || !o.id || o.id.length > 120) { results.push({ id: o?.id, status: 'invalid' }); continue; }
            const ts = Number(o.ts) > 0 ? Math.min(Number(o.ts), Date.now() + 5 * 60 * 1000) : Date.now();
            // --- categorias vivem na tabela categories (unicidade garantida pelo banco) ---
            if (o.entity === 'cat') {
                const curCat = db.prepare('SELECT updated_at, deleted, label, icon, color, type FROM categories WHERE owner = ? AND id = ?').get(userId, o.id) as any;
                if (curCat && curCat.updated_at > ts) {
                    results.push({ id: o.id, status: 'skipped', server: curCat.deleted ? null : { id: o.id, label: curCat.label, icon: curCat.icon, color: curCat.color, type: curCat.type }, deleted: !!curCat.deleted, updated_at: curCat.updated_at });
                    continue;
                }
                const catJson = (c: any) => JSON.stringify({ id: o.id, label: c.label, icon: c.icon, color: c.color, type: c.type });
                if (o.op === 'delete') {
                    if (curCat && !curCat.deleted) {
                        db.prepare('UPDATE categories SET deleted = 1, updated_at = ? WHERE owner = ? AND id = ?').run(ts, userId, o.id);
                        addHist.run(Date.now(), device, 'cat', o.id, 'delete', catJson(curCat), null, userId);
                        applied++;
                    }
                    results.push({ id: o.id, status: 'applied' });
                    continue;
                }
                if (o.op !== 'upsert' || o.data === null || typeof o.data !== 'object' || Array.isArray(o.data)) { results.push({ id: o.id, status: 'invalid' }); continue; }
                const d = o.data as any;
                const label = String(d.label || '').trim().slice(0, 60);
                if (!label) { results.push({ id: o.id, status: 'invalid' }); continue; }
                const type = d.type === 'despesa' || d.type === 'receita' ? d.type : 'ambos';
                const norm = normLabel(label);
                // nome repetido (mesmo dono e tipo, outro id): o banco recusaria; avisamos bonito antes
                const clash = db.prepare('SELECT id, label FROM categories WHERE owner = ? AND type = ? AND norm_label = ? AND deleted = 0 AND id != ?').get(userId, type, norm, o.id) as any;
                if (clash) { results.push({ id: o.id, status: 'rejected', error: 'Você já tem a categoria "' + clash.label + '".' }); continue; }
                db.prepare(`INSERT INTO categories (owner, id, label, norm_label, icon, color, type, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,0)
                    ON CONFLICT(owner, id) DO UPDATE SET label=excluded.label, norm_label=excluded.norm_label, icon=excluded.icon, color=excluded.color, type=excluded.type, updated_at=excluded.updated_at, deleted=0`)
                    .run(userId, o.id, label, norm, String(d.icon || '🏷️'), String(d.color || ''), type, ts);
                const after = JSON.stringify({ id: o.id, label, icon: String(d.icon || '🏷️'), color: String(d.color || ''), type });
                addHist.run(Date.now(), device, 'cat', o.id, curCat && !curCat.deleted ? 'update' : 'create', curCat && !curCat.deleted ? catJson(curCat) : null, after, userId);
                applied++; results.push({ id: o.id, status: 'applied' });
                continue;
            }
            // --- contas fixas vivem na tabela recs (v5): mesmas regras dos lancamentos ---
            if (o.entity === 'rec') {
                const curRec = db.prepare('SELECT description, cat, cents, due_day, updated_at, deleted FROM recs WHERE owner = ? AND id = ?').get(userId, o.id) as any;
                const recJson = (r: any) => JSON.stringify({ id: o.id, desc: r.description, cat: r.cat, cents: r.cents, dueDay: r.due_day });
                if (curRec && curRec.updated_at > ts) {
                    results.push({ id: o.id, status: 'skipped', server: curRec.deleted ? null : JSON.parse(recJson(curRec)), deleted: !!curRec.deleted, updated_at: curRec.updated_at });
                    continue; // ultima edicao vence: a do servidor e mais nova
                }
                if (o.op === 'delete') {
                    if (curRec && !curRec.deleted) {
                        db.prepare('UPDATE recs SET deleted = 1, updated_at = ? WHERE owner = ? AND id = ?').run(ts, userId, o.id);
                        addHist.run(Date.now(), device, 'rec', o.id, 'delete', recJson(curRec), null, userId);
                        applied++;
                    }
                    results.push({ id: o.id, status: 'applied' });
                    continue;
                }
                if (o.op !== 'upsert' || o.data === null || typeof o.data !== 'object' || Array.isArray(o.data)) { results.push({ id: o.id, status: 'invalid' }); continue; }
                const d = o.data as any;
                if (d.id !== o.id || !validNewRec(d)) { results.push({ id: o.id, status: 'invalid' }); continue; }
                // a categoria precisa existir (chave estrangeira): avisa bonito em vez de estourar o lote
                if (!db.prepare('SELECT 1 FROM categories WHERE owner = ? AND id = ?').get(userId, String(d.cat))) {
                    results.push({ id: o.id, status: 'rejected', error: 'Categoria não encontrada.' });
                    continue;
                }
                const desc = capFirst(String(d.desc));
                db.prepare(`INSERT INTO recs (owner, id, description, cat, cents, due_day, updated_at, deleted) VALUES (?,?,?,?,?,?,?,0)
                    ON CONFLICT(owner, id) DO UPDATE SET description=excluded.description, cat=excluded.cat, cents=excluded.cents, due_day=excluded.due_day, updated_at=excluded.updated_at, deleted=0`)
                    .run(userId, o.id, desc, String(d.cat), d.cents, d.dueDay, ts);
                const after = JSON.stringify({ id: o.id, desc, cat: String(d.cat), cents: d.cents, dueDay: d.dueDay });
                addHist.run(Date.now(), device, 'rec', o.id, curRec && !curRec.deleted ? 'update' : 'create', curRec && !curRec.deleted ? recJson(curRec) : null, after, userId);
                applied++; results.push({ id: o.id, status: 'applied' });
                continue;
            }
            // --- lancamentos vivem na tabela transactions (v4): colunas de verdade, categoria com chave estrangeira ---
            if (o.entity === 'tx') {
                const curTx = db.prepare('SELECT date, description, cat, cents, type, rec_key, fitid, updated_at, deleted FROM transactions WHERE owner = ? AND id = ?').get(userId, o.id) as any;
                const txJson = (t: any) => JSON.stringify({ id: o.id, date: t.date, desc: t.description, cat: t.cat, cents: t.cents, type: t.type, ...(t.rec_key ? { recKey: t.rec_key } : {}), ...(t.fitid ? { fitid: t.fitid } : {}) });
                if (curTx && curTx.updated_at > ts) {
                    results.push({ id: o.id, status: 'skipped', server: curTx.deleted ? null : JSON.parse(txJson(curTx)), deleted: !!curTx.deleted, updated_at: curTx.updated_at });
                    continue; // ultima edicao vence: a do servidor e mais nova
                }
                if (o.op === 'delete') {
                    if (curTx && !curTx.deleted) {
                        db.prepare('UPDATE transactions SET deleted = 1, updated_at = ? WHERE owner = ? AND id = ?').run(ts, userId, o.id);
                        addHist.run(Date.now(), device, 'tx', o.id, 'delete', txJson(curTx), null, userId);
                        applied++;
                    }
                    results.push({ id: o.id, status: 'applied' });
                    continue;
                }
                if (o.op !== 'upsert' || o.data === null || typeof o.data !== 'object' || Array.isArray(o.data)) { results.push({ id: o.id, status: 'invalid' }); continue; }
                const d = o.data as any;
                if (d.id !== o.id || !validNewTx(d)) { results.push({ id: o.id, status: 'invalid' }); continue; }
                // a categoria precisa existir (chave estrangeira): avisa bonito em vez de estourar o lote
                if (!db.prepare('SELECT 1 FROM categories WHERE owner = ? AND id = ?').get(userId, String(d.cat))) {
                    results.push({ id: o.id, status: 'rejected', error: 'Categoria não encontrada.' });
                    continue;
                }
                const desc = capFirst(String(d.desc));
                const recKey = d.recKey ? String(d.recKey) : null;
                const fitid = d.fitid ? String(d.fitid) : null;
                db.prepare(`INSERT INTO transactions (owner, id, date, description, cat, cents, type, rec_key, fitid, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)
                    ON CONFLICT(owner, id) DO UPDATE SET date=excluded.date, description=excluded.description, cat=excluded.cat, cents=excluded.cents, type=excluded.type, rec_key=excluded.rec_key, fitid=excluded.fitid, updated_at=excluded.updated_at, deleted=0`)
                    .run(userId, o.id, String(d.date), desc, String(d.cat), d.cents, d.type, recKey, fitid, ts);
                const after = JSON.stringify({ id: o.id, date: String(d.date), desc, cat: String(d.cat), cents: d.cents, type: d.type, ...(recKey ? { recKey } : {}), ...(fitid ? { fitid } : {}) });
                addHist.run(Date.now(), device, 'tx', o.id, curTx && !curTx.deleted ? 'update' : 'create', curTx && !curTx.deleted ? txJson(curTx) : null, after, userId);
                applied++; results.push({ id: o.id, status: 'applied' });
                continue;
            }
            const cur = getRec.get(o.entity, o.id, userId) as any;
            if (cur && cur.updated_at > ts) {
                results.push({ id: o.id, status: 'skipped', server: cur.deleted ? null : JSON.parse(cur.data), deleted: !!cur.deleted, updated_at: cur.updated_at });
                continue; // ultima edicao vence: a do servidor e mais nova
            }
            const before = cur && !cur.deleted ? cur.data : null;
            if (o.op === 'delete') {
                if (!cur || cur.deleted) { results.push({ id: o.id, status: 'applied' }); continue; }
                upRec.run({ entity: o.entity, id: o.id, owner: userId, updated_at: ts, deleted: 1, data: cur.data });
                addHist.run(Date.now(), device, o.entity, o.id, 'delete', before, null, userId);
                applied++; results.push({ id: o.id, status: 'applied' });
            } else if (o.op === 'upsert') {
                if (o.data === null || typeof o.data !== 'object' || Array.isArray(o.data)) { results.push({ id: o.id, status: 'invalid' }); continue; }
                const data = JSON.stringify(o.data);
                if (data.length > 200000) { results.push({ id: o.id, status: 'invalid' }); continue; }
                upRec.run({ entity: o.entity, id: o.id, owner: userId, updated_at: ts, deleted: 0, data });
                addHist.run(Date.now(), device, o.entity, o.id, cur && !cur.deleted ? 'update' : 'create', before, data, userId);
                applied++; results.push({ id: o.id, status: 'applied' });
            } else {
                results.push({ id: o.id, status: 'invalid' });
            }
        }
    });
    tx(ops);
    return { applied, results };
}

// ---------- rotas ----------
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url || '/', 'http://x');
        const p = url.pathname;
        if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, ts: Date.now() });

        const sess = sessionFromCookie(req);

        if (req.method === 'GET' && p === '/api/auth/status') {
            return send(res, 200, sess
                ? { setup: hasUser(), authed: true, username: sess.username, isAdmin: sess.isAdmin }
                : { setup: hasUser(), authed: false });
        }

        if (req.method === 'POST' && p === '/api/auth/setup') {
            if (hasUser()) return send(res, 409, { error: 'O acesso já foi definido.' });
            const body = await readBody(req);
            const user = normUser(body.username);
            const uIssue = usernameIssues(user);
            if (uIssue) return send(res, 400, { error: uIssue });
            const issue = passwordIssues(body.password);
            if (issue) return send(res, 400, { error: issue });
            if (body.password !== body.confirm) return send(res, 400, { error: 'As duas senhas não conferem.' });
            db.prepare('INSERT INTO users (id, username, pass_hash, created_at, is_admin, active) VALUES (1, ?, ?, ?, 1, 1)').run(user, hashPassword(body.password), Date.now());
            const device = String(body.device || '').slice(0, 80);
            const s = createSession(device, 1);
            return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader(s.token, SESSION_TTL_MS / 1000) });
        }

        if (req.method === 'POST' && p === '/api/auth/login') {
            const key = 'ip:' + clientIp(req);
            const lock = lockInfo(key);
            if (lock.locked) return send(res, 429, { error: `Muitas tentativas. Tente de novo em ${Math.ceil(lock.waitSec / 60)} min.`, waitSec: lock.waitSec });
            const body = await readBody(req);
            const row = db.prepare('SELECT id, pass_hash, active FROM users WHERE username = ?').get(normUser(body.username)) as any;
            const ok = verifyPassword(String(body.password ?? ''), row ? row.pass_hash : DUMMY_HASH);
            if (!row || !row.active || !ok) { noteFail(key); return send(res, 401, { error: 'Usuário ou senha incorretos.' }); } // desativado: mesmo erro generico, sem revelar
            clearFails(key);
            const device = String(body.device || '').slice(0, 80);
            const s = createSession(device, row.id);
            return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader(s.token, SESSION_TTL_MS / 1000) });
        }

        if (req.method === 'POST' && p === '/api/auth/logout') {
            if (sess) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sess.token));
            return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader('x', 0) });
        }

        if (req.method === 'POST' && p === '/api/auth/register') {
            // entrada por convite: uso unico, 3 dias, o convidado escolhe a propria senha.
            const body = await readBody(req);
            const hash = sha256(String(body.invite || ''));
            const user = normUser(body.username);
            const uIssue = usernameIssues(user);
            if (uIssue) return send(res, 400, { error: uIssue });
            const issue = passwordIssues(body.password);
            if (issue) return send(res, 400, { error: issue });
            if (body.password !== body.confirm) return send(res, 400, { error: 'As duas senhas não conferem.' });
            // atomico: conferir o convite, depois o nome, criar a conta e marcar como usado numa transacao so
            // (convite ANTES do nome: sem convite valido, a resposta e sempre a mesma — nao da pra sondar quais usuarios existem)
            const reg = db.transaction(() => {
                const inv = db.prepare('SELECT expires_at, used_at FROM invites WHERE token_hash = ?').get(hash) as any;
                if (!inv || inv.used_at || Date.now() > inv.expires_at) return 'invite';
                if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(user)) return 'taken';
                const r = db.prepare('INSERT INTO users (username, pass_hash, created_at, is_admin, active) VALUES (?,?,?,0,1)')
                    .run(user, hashPassword(body.password), Date.now());
                db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(Date.now(), hash);
                return Number(r.lastInsertRowid);
            });
            const newId = reg();
            if (newId === 'invite') return send(res, 401, { error: 'Convite inválido ou vencido.' }); // generico: nao distingue inexistente/usado/vencido
            if (newId === 'taken') return send(res, 409, { error: 'Esse nome de usuário já está em uso.' });
            const device = String(body.device || '').slice(0, 80);
            const s = createSession(device, newId);
            return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader(s.token, SESSION_TTL_MS / 1000) });
        }

        // daqui para baixo: so autenticado (sessao de login OU token de servico)
        const auth: Auth | null = sess ? { kind: 'session', device: sess.device, userId: sess.userId } : serviceFromHeader(req);
        if (!auth) return send(res, 401, { error: 'Entre com a sua senha.' });
        if (!hasUser()) return send(res, 409, { error: 'Setup pendente.' });
        if (auth.kind === 'service') {
            const can = (sc: string) => auth.scopes!.has(sc);
            const allowed = (p === '/api/sync') || (p === '/api/state' && can('read'));
            if (!allowed) return send(res, 403, { error: 'Este acesso não tem essa permissão.' });
        }

        // ---------- administrador (so sessao, so admin; nunca toca nos dados dos usuarios) ----------
        const isAdmin = auth.kind === 'session' && !!db.prepare('SELECT 1 FROM users WHERE id = ? AND is_admin = 1 AND active = 1').get(auth.userId);

        if (req.method === 'GET' && p === '/api/admin/users') {
            if (!isAdmin) return send(res, 403, { error: 'Só o administrador.' });
            const rows = db.prepare('SELECT id, username, created_at, is_admin, active FROM users ORDER BY id').all() as any[];
            return send(res, 200, { users: rows.map(r => ({ id: r.id, username: r.username, created_at: r.created_at, is_admin: !!r.is_admin, active: !!r.active })) });
        }

        if (req.method === 'POST' && p === '/api/admin/users/active') {
            if (!isAdmin) return send(res, 403, { error: 'Só o administrador.' });
            const body = await readBody(req);
            const targetId = Number(body.userId);
            const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(targetId) as any;
            if (!target) return send(res, 404, { error: 'Usuário não encontrado.' });
            const active = body.active ? 1 : 0;
            if (!active && target.id === auth.userId) return send(res, 400, { error: 'Você não pode desativar a própria conta.' });
            if (!active && target.is_admin) {
                const admins = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND active = 1').get() as any).n;
                if (admins <= 1) return send(res, 400, { error: 'É o único administrador ativo.' });
            }
            db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, target.id);
            if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id); // sessoes morrem na hora
            return send(res, 200, { ok: true, userId: target.id, active: !!active });
        }

        if (req.method === 'GET' && p === '/api/admin/invites') {
            if (!isAdmin) return send(res, 403, { error: 'Só o administrador.' });
            const now = Date.now();
            const rows = db.prepare('SELECT i.token_hash, i.created_at, i.expires_at, i.used_at, u.username AS by FROM invites i JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC').all() as any[];
            return send(res, 200, {
                invites: rows.map(r => ({
                    ref: String(r.token_hash).slice(0, 8), created_at: r.created_at, expires_at: r.expires_at, used_at: r.used_at, by: r.by,
                    status: r.used_at ? 'usado' : (now > r.expires_at ? 'vencido' : 'ativo'),
                })),
            });
        }

        if (req.method === 'POST' && p === '/api/admin/invites') {
            if (!isAdmin) return send(res, 403, { error: 'Só o administrador.' });
            const token = crypto.randomBytes(32).toString('base64url');
            const now = Date.now();
            db.prepare('INSERT INTO invites (token_hash, created_by, created_at, expires_at, used_at) VALUES (?,?,?,?,NULL)')
                .run(sha256(token), auth.userId, now, now + INVITE_TTL_MS);
            // o token vai no fragmento (#): nao chega ao servidor nem fica em log
            if (!APP_URL) return send(res, 500, { error: 'APP_URL não configurada no servidor.' });
            // o token vai no fragmento (#): nao chega ao servidor nem fica em log
            return send(res, 200, { ok: true, token, expires_at: now + INVITE_TTL_MS, link: `${APP_URL}/#convite=${token}` });
        }

        if (req.method === 'GET' && p === '/api/state') {
            const out: Record<string, any[]> = {};
            for (const e of ENTITIES) out[e] = [];
            const rows = db.prepare("SELECT entity, data FROM records WHERE deleted = 0 AND owner = ? AND entity NOT IN ('cat', 'tx', 'rec')").all(auth.userId) as any[];
            for (const r of rows) out[r.entity].push(JSON.parse(r.data));
            // categorias vem da tabela (fonte da verdade), no mesmo formato de record que o app espera
            const catRows = db.prepare('SELECT id, label, icon, color, type FROM categories WHERE owner = ? AND deleted = 0').all(auth.userId) as any[];
            for (const c of catRows) out['cat'].push({ id: c.id, label: c.label, icon: c.icon, color: c.color, type: c.type });
            // lancamentos vem da tabela (fonte da verdade), no mesmo formato JSON que o app espera
            const txRows = db.prepare('SELECT id, date, description, cat, cents, type, rec_key, fitid FROM transactions WHERE owner = ? AND deleted = 0').all(auth.userId) as any[];
            for (const t of txRows) out['tx'].push({ id: t.id, date: t.date, desc: t.description, cat: t.cat, cents: t.cents, type: t.type, ...(t.rec_key ? { recKey: t.rec_key } : {}), ...(t.fitid ? { fitid: t.fitid } : {}) });
            // contas fixas vem da tabela (fonte da verdade), no mesmo formato JSON que o app espera
            const recRows = db.prepare('SELECT id, description, cat, cents, due_day FROM recs WHERE owner = ? AND deleted = 0').all(auth.userId) as any[];
            for (const r of recRows) out['rec'].push({ id: r.id, desc: r.description, cat: r.cat, cents: r.cents, dueDay: r.due_day });
            return send(res, 200, { serverTime: Date.now(), records: out });
        }

        if (req.method === 'POST' && p === '/api/sync') {
            const body = await readBody(req);
            if (auth.kind === 'service') {
                // escopos: tx:create (novo), tx:edit (alterar existente), tx:delete. Lote pequeno, tudo ou nada.
                const can = (sc: string) => auth.scopes!.has(sc);
                const ops = Array.isArray(body.ops) ? body.ops.slice(0, 50) : [];
                if (!ops.length) return send(res, 400, { error: 'Nada para lançar.' });
                const exists = db.prepare('SELECT deleted FROM transactions WHERE owner = ? AND id = ?');
                for (const o of ops) {
                    if (o?.entity !== 'tx') return send(res, 403, { error: 'Este acesso só lança despesas e receitas.' });
                    const cur = exists.get(auth.userId, String(o?.id || '')) as any;
                    if (o.op === 'delete') {
                        if (!can('tx:delete')) return send(res, 403, { error: 'Este acesso não pode apagar lançamentos.' });
                    } else if (o.op === 'upsert') {
                        if (!validNewTx(o.data)) return send(res, 400, { error: 'Lançamento incompleto (data, descrição, categoria, valor).' });
                        if (o.data.id !== o.id) return send(res, 400, { error: 'Id do lançamento não confere.' });
                        if (cur && !cur.deleted && !can('tx:edit')) return send(res, 403, { error: 'Este acesso não pode editar lançamentos.' });
                        if (!cur && !can('tx:create')) return send(res, 403, { error: 'Este acesso não pode criar lançamentos.' });
                        if (cur && cur.deleted && !can('tx:create')) return send(res, 403, { error: 'Este acesso não pode criar lançamentos.' });
                    } else {
                        return send(res, 400, { error: 'Operação inválida.' });
                    }
                }
                const r = applyOps(auth.device, auth.userId, ops);
                return send(res, 200, { serverTime: Date.now(), applied: r.applied, results: r.results });
            }
            const ops = Array.isArray(body.ops) ? body.ops.slice(0, 2000) : [];
            const device = String(body.device || auth.device || '').slice(0, 80);
            const r = applyOps(device, auth.userId, ops);
            return send(res, 200, { serverTime: Date.now(), applied: r.applied, results: r.results });
        }

        if (req.method === 'GET' && p === '/api/service-tokens') {
            if (auth.kind !== 'session') return send(res, 403, { error: 'Este acesso não tem essa permissão.' });
            const rows = db.prepare('SELECT label, scopes, created_at, expires_at, last_used_at FROM service_tokens WHERE user_id = ? ORDER BY created_at DESC').all(auth.userId) as any[];
            return send(res, 200, {
                tokens: rows.map(r => ({ label: r.label, scopes: String(r.scopes).split(','), created_at: r.created_at, expires_at: r.expires_at, last_used_at: r.last_used_at })),
            });
        }

        if (req.method === 'POST' && p === '/api/service-tokens') {
            if (auth.kind !== 'session') return send(res, 403, { error: 'Este acesso não tem essa permissão.' });
            const body = await readBody(req);
            const label = String(body.label || '').trim().slice(0, 80);
            const scopes: string[] = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
            if (!label) return send(res, 400, { error: 'Dê um nome para o acesso (ex.: Instinct WhatsApp).' });
            if (!scopes.length || scopes.some(sc => !VALID_SCOPES.has(sc))) return send(res, 400, { error: 'Permissões inválidas.' });
            const dup = db.prepare('SELECT 1 AS x FROM service_tokens WHERE label = ? AND user_id = ?').get(label, auth.userId);
            if (dup) return send(res, 409, { error: 'Já existe um acesso com esse nome. Revogue-o antes de criar outro.' });
            const days = Number(body.expiresDays) || 0; // 0/ausente = sem validade
            const token = 'dindin_svc_' + crypto.randomBytes(32).toString('base64url');
            db.prepare('INSERT INTO service_tokens (token_hash, label, scopes, created_at, expires_at, last_used_at, user_id) VALUES (?,?,?,?,?,NULL,?)')
                .run(sha256(token), label, scopes.join(','), Date.now(), days > 0 ? Date.now() + days * 86400000 : null, auth.userId);
            return send(res, 200, { ok: true, token, label, scopes, expires_at: days > 0 ? Date.now() + days * 86400000 : null });
        }

        if (req.method === 'POST' && p === '/api/service-tokens/revoke') {
            if (auth.kind !== 'session') return send(res, 403, { error: 'Este acesso não tem essa permissão.' });
            const body = await readBody(req);
            const label = String(body.label || '').slice(0, 80);
            const n = db.prepare('DELETE FROM service_tokens WHERE label = ? AND user_id = ?').run(label, auth.userId).changes;
            return send(res, n ? 200 : 404, { ok: !!n, error: n ? undefined : 'Acesso não encontrado.' });
        }

        if (req.method === 'GET' && p === '/api/history') {
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
            const device = String(url.searchParams.get('device') || '').slice(0, 80);
            const rows = (device
                ? db.prepare('SELECT seq, ts, device, entity, rid, op, before, after FROM history WHERE owner = ? AND device = ? ORDER BY seq DESC LIMIT ?').all(auth.userId, device, limit)
                : db.prepare('SELECT seq, ts, device, entity, rid, op, before, after FROM history WHERE owner = ? ORDER BY seq DESC LIMIT ?').all(auth.userId, limit)) as any[];
            return send(res, 200, {
                entries: rows.map(r => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null })),
            });
        }

        return send(res, 404, { error: 'Rota não encontrada.' });
    } catch (e: any) {
        if (String(e?.message || '').includes('JSON') || String(e?.message || '').includes('body')) return send(res, 400, { error: e.message });
        console.error('erro interno:', e);
        return send(res, 500, { error: 'Erro interno.' });
    }
});

server.listen(PORT, HOST, () => console.log(`dindin-api ouvindo em http://${HOST}:${PORT}`));
