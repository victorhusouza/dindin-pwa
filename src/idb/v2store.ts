// Caminho v2 EXPERIMENTAL (ensaio): boot, espelho em memoria, mutacoes via T1
// e MOTOR DE SYNC isolado (motor.ts) atras de meta 'motor'='on'. SEM migracao,
// SEM T2 — a flag so existe se o FIXTURE de ensaio gravar (window.__v2fixture).
// Nenhum fluxo de usuario cria a flag nem liga o motor. O banner declara o modo
// experimental. Nada aqui prova prontidao.

import { openMF, runTx, req, kSnap, k3, kMeta, kOp, kConflict, OK } from './db';
import type { T1Result } from './db';
import type { BaseProvider, ConflictRecordV2 } from './syncIDB';
import { applyIntent, readCollectionIDB, readConflictsIDB, applyReapply, discardConflictV2, readOutboxIDB, applyCorrigeBloqueada } from './syncIDB';
import type { SyncOpV2 } from './syncIDB';

export type EntityV2 = 'tx' | 'cat' | 'rec' | 'catrule';
const ENTIDADES: EntityV2[] = ['tx', 'cat', 'rec', 'catrule'];
type Rec = Record<string, unknown>;

let db: IDBDatabase | null = null;
let contaAtiva = '';
let ativo = false;
const espelho = new Map<EntityV2, Rec[]>();
let espelhoConflicts: ConflictRecordV2[] = [];
const ouvintes = new Set<() => void>();
const notifica = (): void => { for (const f of ouvintes) f(); };

export function v2IsActive(): boolean { return ativo; }
export function v2Conta(): string { return contaAtiva; }

async function getMeta(conta: string, chave: string): Promise<unknown> {
    const d = await openMF();
    try {
        const tx = d.transaction(['meta'], 'readonly');
        return await req<unknown>(tx.objectStore('meta').get(kMeta(conta, chave)));
    } finally { d.close(); }
}

// Boot v2: retorna true SOMENTE se a flag de ensaio existir; carrega o espelho.
// NUNCA cria a flag (isso sera a migracao, hoje bloqueada).
export async function v2Boot(conta: string): Promise<boolean> {
    try {
        const flag = await getMeta(conta, 'fmt');
        if (flag !== 'v2-exp') return false;
        db = await openMF();
        contaAtiva = conta;
        for (const e of ENTIDADES) espelho.set(e, await readCollectionIDB(db, conta, e));
        espelhoConflicts = await readConflictsIDB(db, conta);
        motorLigado = (await getMeta(conta, 'motor')) === 'on';
        ativo = true;
        await v2RefreshEspelho(); // espelho + versoes oficiais atomicos no primeiro render
        return true;
    } catch {
        return false; // IDB indisponivel: cai para o caminho v1 (fallback a verificar — declarado)
    }
}

const idOf = (entity: string, r: unknown): string => {
    if (!r || typeof r !== 'object') return '';
    const o = r as Rec;
    return String(entity === 'catrule' ? (o.key ?? '') : (o.id ?? ''));
};

// Base v2-NATIVA (motor 26/10): NUNCA le/escreve LS/fila v1. A versao oficial
// persistida mora no IDB (meta 'oficial|entity|id'); a base de edicao e a
// versao QUE ESTA ABA renderizou (espelhoVers, memoria desta carga, sincronizado
// com o espelho de registros — avanca so no refresh pos-commit/veredito/hidratacao

const espelhoVers = new Map<string, number>(); // 'entity|id' -> versao oficial renderizada por ESTA aba
const kV = (entity: string, id: string): string => entity + '|' + id;
const pinsV2 = new Map<string, { base: number | null; token: unknown }>();
let tokenV2 = 0;
const provider: BaseProvider = {
    peek: (entity, id) => {
        const p = pinsV2.get(kV(entity, id));
        if (p) return { base: p.base, token: p.token };
        return { base: espelhoVers.get(kV(entity, id)) ?? null, token: null };
    },
    consume: (entity, id, token) => {
        if (token === null || token === undefined) return;
        const k = kV(entity, id);
        const p = pinsV2.get(k);
        if (p && p.token === token) pinsV2.delete(k); // E4+token: so apaga o MESMO pin
    },
};
// Form aberto congela a base DESTA aba (App chama no lugar de freezeBase no modo v2).
export function v2FreezeBase(entity: string, id: string): void {
    pinsV2.set(kV(entity, id), { base: espelhoVers.get(kV(entity, id)) ?? null, token: ++tokenV2 });
}
export function v2UnfreezeBase(entity: string, id: string): void { pinsV2.delete(kV(entity, id)); }

// Conexao da aba (motor). Null fora do modo v2.
export function v2Db(): IDBDatabase | null { return db; }
// Recarrega espelho + conflitos + versoes oficiais do IDB e notifica UMA vez —
// o render e atomico com as versoes (base pin = o que a aba renderizou).
export async function v2RefreshEspelho(): Promise<void> {
    if (!db || !ativo) return;
    for (const e of ENTIDADES) espelho.set(e, await readCollectionIDB(db, contaAtiva, e));
    espelhoConflicts = await readConflictsIDB(db, contaAtiva);
    espelhoBloqueadas = (await readOutboxIDB(db, contaAtiva)).filter(o => !!o.bloqueada);
    espelhoVers.clear();
    const tx = db.transaction(['meta'], 'readonly');
    const chaves = ((await req<IDBValidKey[]>(tx.objectStore('meta').getAllKeys())) ?? []) as IDBValidKey[];
    const vals = ((await req<unknown[]>(tx.objectStore('meta').getAll())) ?? []) as unknown[];
    const pre = encodeURIComponent(contaAtiva) + '|' + encodeURIComponent('oficial|');
    chaves.forEach((k, i) => {
        const ks = String(k);
        if (!ks.startsWith(pre)) return;
        const chave = decodeURIComponent(ks.slice(pre.length)); // 'entity|id'
        const v = vals[i] as { version?: unknown; deleted?: unknown } | undefined;
        if (v && v.deleted !== true && typeof v.version === 'number') espelhoVers.set(chave, v.version);
    });
    notifica();
}
// Aviso avulso da UI (motor mudou so estado interno, ex.: aviso de recusa).
export function v2Poke(): void { notifica(); }
// Ops RECUSADAS (bloqueadas) com motivo — o espelho da UI de corrigir/descartar.
// Mesma regra de atomiciade do render: recarregado junto com colecoes/conflitos.
let espelhoBloqueadas: SyncOpV2[] = [];
export function v2Bloqueadas(): SyncOpV2[] { return espelhoBloqueadas; }
// Pos-commit: o motor registra um gancho para despachar flush apos escrita local.
let posCommit: (() => void) | null = null;
export function v2SetPosCommit(fn: (() => void) | null): void { posCommit = fn; }
// Motor ligado? meta 'motor'='on' (fixture/ensaio); lido no boot.
let motorLigado = false;
export function v2MotorLigado(): boolean { return motorLigado; }

// Leitura do espelho (render): carregado no boot, avanca so pos-commit da aba.
const VAZIO: Rec[] = []; // referencia ESTAVEL: o snapshot do useSyncExternalStore nao pode mudar sem notificacao
export function v2Collection(entity: EntityV2): Rec[] { return espelho.get(entity) ?? VAZIO; }
export function v2Subscribe(fn: () => void): () => void { ouvintes.add(fn); return () => ouvintes.delete(fn); }

// Mutacao por INTENCAO: leitura da colecao + diff por registro + gravacao na
// MESMA transacao readwrite (applyIntent — sem janela TOCTOU entre abas). A fn
// do chamador e a intencao explicita; o espelho avanca SOMENTE apos o commit,
// com o estado efetivamente commitado (render atomico com a base).
export async function v2Mutate(entity: EntityV2, fn: (fresh: Rec[]) => Rec[]): Promise<T1Result> {
    if (!db || !ativo) return { ok: false, cause: 'closed' };
    let next: Rec[] = [];
    const res = await applyIntent(db, contaAtiva, entity, (fresh) => { next = fn(fresh); return next; }, provider);
    if (res.ok) { espelho.set(entity, next); notifica(); if (posCommit) posCommit(); }
    return res;
}

// ---------- Conflitos experimentais (T7/C20 — tentativas separadas) ----------
// Leitura do espelho; cada tentativa recusada e um item proprio (C20).
export function v2Conflicts(): ConflictRecordV2[] { return espelhoConflicts; }

// REAPLICAR: op nova (op_id novo, base = oficial MOSTRADA, sem sucessor_of) +
// remocao do conflito origem na MESMA tx. As outras tentativas ficam intactas.
export async function v2Reaplicar(c: ConflictRecordV2): Promise<T1Result> {
    if (!db || !ativo) return { ok: false, cause: 'closed' };
    const r = await applyReapply(db, c);
    if (r.ok) {
        espelhoConflicts = await readConflictsIDB(db, contaAtiva);
        espelho.set(c.entity as EntityV2, await readCollectionIDB(db, contaAtiva, c.entity as EntityV2));
        notifica();
        if (posCommit) posCommit();
    }
    return r;
}

// DESCARTAR: veredito terminal SO daquela tentativa.
export async function v2Descartar(c: ConflictRecordV2): Promise<T1Result> {
    if (!db || !ativo) return { ok: false, cause: 'closed' };
    const r = await discardConflictV2(db, c);
    if (r.ok) { espelhoConflicts = await readConflictsIDB(db, contaAtiva); notifica(); }
    return r;
}

// CORRIGIR recusado (ensaio): atomico no syncIDB (guarda de intencao mais nova
// + op nova + remocao da recusada na MESMA tx). Pos-commit: espelho de colecao
// e de bloqueadas recarregados juntos, UMA notificacao — como v2Mutate.
export async function v2CorrigirBloqueada(o: SyncOpV2, record: Rec): Promise<T1Result> {
    if (!db || !ativo) return { ok: false, cause: 'closed' };
    const r = await applyCorrigeBloqueada(db, contaAtiva, o.entity, record, o.op_id, provider);
    if (r.ok) {
        espelho.set(o.entity as EntityV2, await readCollectionIDB(db, contaAtiva, o.entity as EntityV2));
        espelhoBloqueadas = (await readOutboxIDB(db, contaAtiva)).filter(x => !!x.bloqueada);
        notifica();
        if (posCommit) posCommit();
    }
    return r;
}

// FIXTURE DE ENSAIO (teste): semeia registros+snap (iguais — C25) e a flag.
// Nome e chamada explicitamente de teste; nao e migracao; dados ficticios.
export async function v2FixtureSeed(conta: string, dados: Partial<Record<EntityV2, Rec[]>> & { conflicts?: ConflictRecordV2[] }): Promise<void> {
    const d = await openMF();
    await runTx(d, ['records', 'snap', 'meta'], async (tx) => {
        for (const e of ENTIDADES) {
            const arr = dados[e] ?? [];
            for (const r of arr) { const id = idOf(e, r); if (id) await req(tx.objectStore('records').put(r, k3(conta, e, id))); }
            await req(tx.objectStore('snap').put(arr, kSnap(conta, e)));
        }
        await req(tx.objectStore('meta').put(0, kMeta(conta, 'seq')));
        await req(tx.objectStore('meta').put('v2-exp', kMeta(conta, 'fmt')));
    });
    d.close();
    const cf = dados.conflicts ?? [];
    if (cf.length) await v2FixtureConflicts(cf);
}
// Semeia SOMENTE conflitos (uso de teste, no meio da suite, sem tocar o resto).
export async function v2FixtureConflicts(lista: ConflictRecordV2[]): Promise<void> {
    const d = await openMF();
    await runTx(d, ['conflicts'], async (tx) => {
        for (const c of lista) await req(tx.objectStore('conflicts').put(c, kConflict(c.conta, c.entity, c.id, c.op_id)));
    });
    d.close();
    if (db && ativo) { espelhoConflicts = await readConflictsIDB(db, contaAtiva); notifica(); }
}
(window as unknown as Record<string, unknown>).__v2fixture = v2FixtureSeed;
(window as unknown as Record<string, unknown>).__v2conflitos = v2FixtureConflicts;

// FIXTURE DE VEREDITO (teste): simula o que o MOTOR DE SYNC real vai escrever
// quando o servidor recusar uma op pendente — remove a op da fila e grava o
// conflito NOVO com o op_id DELA (tentativa preservada, oficial do veredito).
// O motor nao existe: isto NAO prova servidor; o veredito real ja e provado em
// teste de API separado (v2-veredito-api.mjs). Uso: provar na UI que oficial
// avancada depois da escolha vira conflito NOVO, sem sobrescrever nada.
export async function v2FixtureVeredito(conta: string, opId: string, veredito: { status: string; server?: unknown; version?: number | null; deleted?: boolean }): Promise<boolean> {
    const d = await openMF();
    let gravou = false;
    await runTx(d, ['outbox', 'conflicts'], async (tx) => {
        const op = await req<SyncOpV2 | undefined>(tx.objectStore('outbox').get(kOp(conta, opId)));
        if (!op) return;
        const c: ConflictRecordV2 = {
            conta, entity: op.entity, id: op.id, op_id: op.op_id,
            tentativa: { op: op.op, data: op.data, ts: op.ts, base_v: op.base_v ?? null },
            oficial: veredito.deleted ? null : { data: veredito.server, version: veredito.version ?? null },
            motivo: veredito.status, ts: Date.now(),
        };
        // remocao da fila + conflito novo na MESMA tx: abort preserva os dois
        await req(tx.objectStore('outbox').delete(kOp(conta, opId)));
        await req(tx.objectStore('conflicts').put(c, kConflict(conta, c.entity, c.id, c.op_id)));
        gravou = true;
    });
    d.close();
    if (gravou && db && ativo) { espelhoConflicts = await readConflictsIDB(db, contaAtiva); notifica(); }
    return gravou;
}
(window as unknown as Record<string, unknown>).__v2veredito = v2FixtureVeredito;

