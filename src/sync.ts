// Cliente de sync offline-first contra a API da VM.
// O aparelho continua mandando no proprio estado (localStorage): cada gravacao
// vira operacao numa fila (outbox) que descarrega quando ha internet. Na abertura
// do app, o estado da VM hidrata o aparelho antes da interface renderizar; em
// conflito, a versao mais nova (ultima edicao) vence. A VM e a fonte da verdade.

export interface SyncOp { entity: string; id: string; op: 'upsert' | 'delete'; data?: unknown; ts: number }

const TXS_CHUNKS = 32;
const CHUNK_CAP = 50000;
const OUTBOX_KEY = 'mf.sync.outbox';
const SNAP_PREFIX = 'mf.sync.snap.';
const DEVICE_KEY = 'mf.device';

// Chaves do app que viram colecoes sincronizadas. mf.txs.* (fatias) = entidade tx.
const COLLECTIONS: Record<string, { entity: string }> = {
    'mf.cats.v1': { entity: 'cat' },
    'mf.recs.v1': { entity: 'rec' },
    'mf.catrules.v1': { entity: 'catrule' },
};
const TXS_PREFIX = 'mf.txs.';

export function deviceLabel(): string {
    let d = '';
    try { d = localStorage.getItem(DEVICE_KEY) || ''; } catch { /* sem acesso */ }
    if (!d) {
        const ua = navigator.userAgent;
        d = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'Computador';
        try { localStorage.setItem(DEVICE_KEY, d); } catch { /* sem acesso */ }
    }
    return d;
}

function readOutbox(): SyncOp[] { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; } }
function writeOutbox(ops: SyncOp[]): void { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(ops)); } catch { /* sem acesso */ } }
function readSnap(entity: string): unknown[] { try { const v = JSON.parse(localStorage.getItem(SNAP_PREFIX + entity) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function writeSnap(entity: string, arr: unknown[]): void { try { localStorage.setItem(SNAP_PREFIX + entity, JSON.stringify(arr)); } catch { /* sem acesso */ } }

function idOf(entity: string, rec: unknown): string {
    if (!rec || typeof rec !== 'object') return '';
    const r = rec as Record<string, unknown>;
    return String(entity === 'catrule' ? (r.key ?? '') : (r.id ?? ''));
}

// Le a colecao atual do localStorage. Lançamentos aceitam os dois formatos
// guardados: objeto simples (com id) ou fatia compacta [id, data, desc, cat, cents, tipo, recKey].
function readCollection(entity: string): unknown[] {
    try {
        if (entity === 'tx') {
            // Cada fatia e uma STRING gravada via JSON.stringify (padrao do useLocalState).
            const chunk = (i: number): string => {
                const raw = localStorage.getItem(TXS_PREFIX + i);
                if (raw == null) return '';
                try { const v = JSON.parse(raw); return typeof v === 'string' ? v : (Array.isArray(v) ? JSON.stringify(v) : ''); }
                catch { return raw; }
            };
            let joined = '';
            for (let i = 0; i < TXS_CHUNKS; i++) joined += chunk(i);
            if (!joined) return [];
            const raw: unknown = JSON.parse(joined);
            if (!Array.isArray(raw)) return [];
            return raw.map(p => {
                if (Array.isArray(p) && p.length >= 7) return { id: p[0], date: p[1], desc: p[2], cat: p[3], cents: p[4], type: p[5] === 'r' ? 'receita' : 'despesa', recKey: p[6] ? p[6] : undefined };
                if (p && typeof p === 'object' && 'id' in p) return p;
                return null;
            }).filter(Boolean) as unknown[];
        }
        const key = Object.keys(COLLECTIONS).find(k => COLLECTIONS[k].entity === entity);
        if (!key) return [];
        const raw: unknown = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch { return []; }
}

// Aviso vindo do useLocalState: uma chave mudou. Recalcula a diferenca da
// colecao contra o ultimo estado sincronizado e enfileira as operacoes.
export function notifyChange(key: string): void {
    const entity = key.startsWith(TXS_PREFIX) ? 'tx' : COLLECTIONS[key]?.entity;
    if (!entity) return;
    const cur = readCollection(entity);
    const snap = readSnap(entity);
    const snapMap = new Map(snap.map(r => [idOf(entity, r), JSON.stringify(r)]));
    const curIds = new Set(cur.map(r => idOf(entity, r)));
    const now = Date.now();
    const ops: SyncOp[] = [];
    for (const r of cur) {
        const id = idOf(entity, r);
        if (id && snapMap.get(id) !== JSON.stringify(r)) ops.push({ entity, id, op: 'upsert', data: r, ts: now });
    }
    for (const r of snap) {
        const id = idOf(entity, r);
        if (id && !curIds.has(id)) ops.push({ entity, id, op: 'delete', ts: now });
    }
    if (ops.length) {
        const rest = readOutbox().filter(o => !ops.some(n => n.entity === o.entity && n.id === o.id));
        writeOutbox([...rest, ...ops]);
    }
    writeSnap(entity, cur);
    scheduleFlush();
}

let onAuthLost: (() => void) | null = null;
export function setAuthLostHandler(fn: () => void): void { onAuthLost = fn; }

let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { void flush(); }, 800);
}

export async function flush(): Promise<void> {
    if (flushing) return;
    const ops = readOutbox();
    if (!ops.length) return;
    flushing = true;
    try {
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device: deviceLabel(), ops }),
            credentials: 'same-origin',
        });
        if (res.status === 401) { onAuthLost?.(); return; }
        if (!res.ok) return; // erro do servidor: fila fica para a proxima tentativa
        const body = await res.json();
        const sent = new Set(ops.map(o => `${o.entity}${o.id}${o.ts}`));
        writeOutbox(readOutbox().filter(o => !sent.has(`${o.entity}${o.id}${o.ts}`)));
        const conflicts = ((body.results || []) as { status: string }[]).filter(r => r.status === 'skipped' || r.status === 'rejected'); // rejected: o servidor recusou (ex.: categoria com nome repetido) — o estado oficial vence
        if (conflicts.length) {
            // Outra versao mais nova venceu no servidor: puxa o estado oficial e recarrega.
            await hydrate();
            window.location.reload();
        }
    } catch { /* offline: a fila espera a proxima tentativa */ }
    finally { flushing = false; }
}

// Puxa o estado oficial da VM para o aparelho e depois empurra a fila local.
export async function hydrate(): Promise<void> {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (res.status === 401) throw new Error('auth');
    if (!res.ok) throw new Error('state');
    const body = await res.json();
    const recs = body.records || {};
    const txs = Array.isArray(recs.tx) ? recs.tx : [];
    const s = JSON.stringify(txs);
    for (let i = 0; i < TXS_CHUNKS; i++) {
        try { localStorage.setItem(TXS_PREFIX + i, JSON.stringify(s.slice(i * CHUNK_CAP, (i + 1) * CHUNK_CAP))); } catch { /* sem acesso */ }
    }
    for (const [key, cfg] of Object.entries(COLLECTIONS)) {
        const arr = Array.isArray(recs[cfg.entity]) ? recs[cfg.entity] : [];
        try { localStorage.setItem(key, JSON.stringify(arr)); } catch { /* sem acesso */ }
    }
    for (const e of ['tx', 'cat', 'rec', 'catrule']) writeSnap(e, Array.isArray(recs[e]) ? recs[e] : []);
    await flush();
}

// Auto-refresh Fase 1: ao voltar para o app/aba, empurra a fila local e puxa o
// estado oficial. Se o servidor tinha algo que o aparelho nao tinha, recarrega
// para renderizar os dados novos (mesmo padrao do conflito em flush()).
function snapshotData(): string {
    let s = '';
    for (let i = 0; i < TXS_CHUNKS; i++) s += localStorage.getItem(TXS_PREFIX + i) || '';
    for (const k of Object.keys(COLLECTIONS)) s += '|' + (localStorage.getItem(k) || '');
    return s;
}

function formEmUso(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

let refreshing = false;
export async function refreshFromServer(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
        await flush(); // empurra primeiro: protege o que ainda nao subiu
        const antes = snapshotData();
        await hydrate();
        if (snapshotData() !== antes && !formEmUso()) window.location.reload();
    } catch { /* offline ou erro: tenta de novo no proximo evento */ }
    finally { refreshing = false; }
}


// Auto-refresh Fase 2: com a aba visivel, pergunta a cada 30s se o servidor
// tem algo novo (GET /api/history?limit=1, resposta minuscula: 1 registro).
// O seq so sobe quando algo muda; se subiu, roda o ciclo completo da Fase 1
// (empurra fila, puxa estado, recarrega so se os dados mudaram e nenhum
// campo estiver em foco).
const POLL_MS = 30000;
let lastSeq: number | null = null;
async function pollServerSeq(): Promise<void> {
    if (document.hidden || refreshing) return;
    try {
        await flush(); // empurra antes: o seq lido ja reflete o que subiu daqui
        const res = await fetch('/api/history?limit=1', { credentials: 'same-origin' });
        if (res.status === 401) { onAuthLost?.(); return; }
        if (!res.ok) return;
        const body = await res.json();
        const seq = Number(body?.entries?.[0]?.seq) || 0;
        if (lastSeq === null) { lastSeq = seq; return; } // a abertura ja hidratou o estado
        if (seq !== lastSeq) {
            lastSeq = seq;
            await refreshFromServer();
        }
    } catch { /* offline ou erro: proxima pergunta em 30s */ }
}

export function startSyncLoop(): void {
    window.addEventListener('online', () => void flush());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshFromServer(); });
    window.addEventListener('focus', () => void refreshFromServer());
    setInterval(() => void flush(), 20000);
    setInterval(() => void pollServerSeq(), POLL_MS);
    void pollServerSeq(); // marca o seq atual como base (nunca recarrega)
}
