// dindin API: login multiusuario (convite em fase posterior), sync offline-first e historico.
// Isolamento: toda rota de dados filtra por owner = usuario da sessao/token (T2).
// Sem framework: node:http + better-sqlite3. Roda em 127.0.0.1 atras do Caddy.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;       // sessao deslizante: 7 dias
const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;      // teto absoluto: 30 dias
const LOCK_FAILS = 5;                              // tentativas antes do bloqueio
const LOCK_MS = 15 * 60 * 1000;                    // bloqueio de 15 minutos
const MAX_BODY = 1024 * 1024;                      // 1 MB por requisicao
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
function sessionFromCookie(req: http.IncomingMessage): { token: string; device: string; userId: number } | null {
    const raw = req.headers.cookie || '';
    const m = /(?:^|;\s*)dindin_s=([A-Za-z0-9_-]+)/.exec(raw);
    if (!m) return null;
    const token = m[1];
    const row = db.prepare('SELECT s.created_at, s.expires_at, s.device, s.user_id, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha256(token)) as any;
    if (!row) return null;
    if (!row.active) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); return null; } // usuario desativado: sessao morre aqui
    const now = Date.now();
    if (now > row.expires_at || now > row.created_at + SESSION_MAX_MS) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
        return null;
    }
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL_MS, sha256(token)); // deslizante
    return { token, device: row.device, userId: row.user_id };
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
        for (const o of list) {
            if (!ENTITIES.has(o.entity) || typeof o.id !== 'string' || !o.id || o.id.length > 120) { results.push({ id: o?.id, status: 'invalid' }); continue; }
            const ts = Number(o.ts) > 0 ? Math.min(Number(o.ts), Date.now() + 5 * 60 * 1000) : Date.now();
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
            return send(res, 200, { setup: hasUser(), authed: !!sess });
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

        // daqui para baixo: so autenticado (sessao de login OU token de servico)
        const auth: Auth | null = sess ? { kind: 'session', device: sess.device, userId: sess.userId } : serviceFromHeader(req);
        if (!auth) return send(res, 401, { error: 'Entre com a sua senha.' });
        if (!hasUser()) return send(res, 409, { error: 'Setup pendente.' });
        if (auth.kind === 'service') {
            const can = (sc: string) => auth.scopes!.has(sc);
            const allowed = (p === '/api/sync') || (p === '/api/state' && can('read'));
            if (!allowed) return send(res, 403, { error: 'Este acesso não tem essa permissão.' });
        }

        if (req.method === 'GET' && p === '/api/state') {
            const out: Record<string, any[]> = {};
            for (const e of ENTITIES) out[e] = [];
            const rows = db.prepare('SELECT entity, data FROM records WHERE deleted = 0 AND owner = ?').all(auth.userId) as any[];
            for (const r of rows) out[r.entity].push(JSON.parse(r.data));
            return send(res, 200, { serverTime: Date.now(), records: out });
        }

        if (req.method === 'POST' && p === '/api/sync') {
            const body = await readBody(req);
            if (auth.kind === 'service') {
                // escopos: tx:create (novo), tx:edit (alterar existente), tx:delete. Lote pequeno, tudo ou nada.
                const can = (sc: string) => auth.scopes!.has(sc);
                const ops = Array.isArray(body.ops) ? body.ops.slice(0, 50) : [];
                if (!ops.length) return send(res, 400, { error: 'Nada para lançar.' });
                const exists = db.prepare('SELECT deleted FROM records WHERE entity = ? AND id = ? AND owner = ?');
                for (const o of ops) {
                    if (o?.entity !== 'tx') return send(res, 403, { error: 'Este acesso só lança despesas e receitas.' });
                    const cur = exists.get('tx', String(o?.id || ''), auth.userId) as any;
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
