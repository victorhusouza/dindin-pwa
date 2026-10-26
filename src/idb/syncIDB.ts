// T1 — gravacao local v2: mutacao POR REGISTRO em UMA transacao IDB.

// - NUNCA set de colecao do espelho: put/delete explicito, valor+base da aba.
// - Ordem de despacho e antecessor por SEQ MONOTONICO por conta (meta conta|seq),
//   nao por ts/UUID (E1). A seq e gravada na mesma transacao da op.
// - Registro sem id: REJEITADO com ok:false/cause 'invalid' — nada gravado (E2).
// - Causa discriminavel: quota/closed/invalid/error (E3).
// - Base: PEEK dentro da transacao; CONSUME so apos o commit (E4) — abort+retry
//   preserva a base congelada.
// - Conexao fechada por upgrade: cause 'closed' — o chamador avisa e NAO retenta (E5).


// page load. Coalesce SOMENTE sobre a ultima op pendente do item do MESMO
// writer; op pendente de outro writer (ou legada, sem writer) NUNCA e fundida
// nem recebe sucessor_of da outra — as tentativas seguem independentes e o CAS
// do servidor decide o oficial. Conflito por TENTATIVA (kConflict): a segunda
// recusa no mesmo registro NAO substitui a primeira.

import { runTx, req, k3, kSnap, kOp, kMeta, kConflict, classify, closedByUpgrade, OK } from './db';
import type { T1Result } from './db';

export interface SyncOpV2 {
    conta: string; entity: string; id: string; op: 'upsert' | 'delete';
    data?: unknown; ts: number; base_v: number | null;
    op_id: string; sucessor_of: string | null; sent?: boolean;
    seq: number; // ordem de despacho e antecessor — monotonico por conta (E1)
    writer?: string; // UUID em MEMORIA por page load; ausente = op legada (nunca fundida)
    bloqueada?: string; // motivo da recusa 'rejected' do servidor: a op FICA, mas o
    // reenvio AUTOMATICO fica BLOQUEADO ate acao explicita do usuario (editar o
    // item de novo — o coalesce substitui — ou desbloqueio explicito). NUNCA

}
type Rec = Record<string, unknown>;
export type Mutation = { type: 'upsert'; record: Rec } | { type: 'delete'; id: string };

// Base por aba: peek NAO consome; consume roda SOMENTE apos commit (E4) e SOMENTE
// se o pin atual ainda for o MESMO do peek — identidade por token, nao por versao

// registro e o consume atrasado NAO pode apaga-lo. O provider do app honra o
// token (freezeBase/pinBase passam a guardar token junto da versao).
export interface BasePin { base: number | null; token: unknown }
export interface BaseProvider {
    peek(entity: string, id: string): BasePin;
    consume(entity: string, id: string, token: unknown): void;
}

const novoOpId = (): string => { try { return crypto.randomUUID(); } catch { return 'op' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } };

// Identidade do escritor DESTA carga de pagina (memoria, NAO sessionStorage:
// aba duplicada/clonada recebe writer proprio; reload recebe writer novo e as
// ops anteriores ao reload ficam intocadas — nunca fundidas, por decisao).
const WRITER_ID: string = (() => { try { return crypto.randomUUID(); } catch { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } })();
export const writerId = (): string => WRITER_ID;
const mesmoWriter = (o: SyncOpV2): boolean => o.writer === WRITER_ID;
const idOf = (entity: string, r: unknown): string => {
    if (!r || typeof r !== 'object') return '';
    const o = r as Rec;
    return String(entity === 'catrule' ? (o.key ?? '') : (o.id ?? ''));
};

// Serializacao GLOBAL de escritas da aba (T1 e, no futuro, T2 na mesma cadeia).
let cadeia: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = cadeia.then(fn, fn);
    cadeia = p.catch(() => { /* erro ja entregue ao chamador */ });
    return p;
}

async function proximaSeq(tx: IDBTransaction, conta: string): Promise<number> {
    const st = tx.objectStore('meta');
    const cur = (await req<number | undefined>(st.get(kMeta(conta, 'seq')))) ?? 0;
    const seq = cur + 1;
    await req(st.put(seq, kMeta(conta, 'seq')));
    return seq;
}

// JSON canonico (chaves ordenadas, undefined fora): o servidor devolve os
// registros com ORDEM de chaves propria; comparar JSON.stringify cru fazia a
// paridade falhar depois de qualquer hidratacao (op redundante em save sem

const canonJSON = (v: unknown): string => {
    if (Array.isArray(v)) return '[' + v.map(canonJSON).join(',') + ']';
    if (v && typeof v === 'object') {
        const o = v as Rec;
        return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonJSON(o[k])).join(',') + '}';
    }
    const j = JSON.stringify(v);
    return j === undefined ? 'null' : j;
};

// Nucleo por registro DENTRO de uma transacao. Devolve o (entity,id) quando
// gerou op — o chamador consome a base DESSE item somente apos o commit.
async function mutaRegistro(
    tx: IDBTransaction, conta: string, entity: string, m: Mutation,
    base: BaseProvider, now: number, consumidos: { entity: string; id: string; token: unknown }[],
): Promise<void> {
    const stRec = tx.objectStore('records');
    const stSnap = tx.objectStore('snap');
    const stOb = tx.objectStore('outbox');
    const snap = ((await req<Rec[] | undefined>(stSnap.get(kSnap(conta, entity)))) ?? []) as Rec[];
    const filaItem = (((await req<SyncOpV2[]>(stOb.getAll())) ?? []) as SyncOpV2[])
        .filter(o => o.conta === conta && o.entity === entity && o.id === (m.type === 'upsert' ? idOf(entity, m.record) : m.id));
    // Antecessor = MAIOR seq pendente do item (E1), nao ultimo por chave/ts.
    // Op BLOQUEADA (rejected) NUNCA e antecessora: coalesce sobre ela engoliria

    const ant = filaItem.filter(o => o.op_id && !o.bloqueada).sort((a, b) => a.seq - b.seq).pop();
    if (m.type === 'upsert') {
        const id = idOf(entity, m.record);
        if (!id) throw new Error('invalid: registro sem id'); // E2: rejeitado, tx aborta
        const entrada = snap.find(r => idOf(entity, r) === id);
        if (entrada && canonJSON(entrada) === canonJSON(m.record)) return; // paridade: identico nao gera op
        const pin = base.peek(entity, id);
        const op: SyncOpV2 = { conta, entity, id, op: 'upsert', data: m.record, ts: now, base_v: pin.base, op_id: novoOpId(), sucessor_of: null, seq: await proximaSeq(tx, conta), writer: WRITER_ID };

        // DESTE writer, NUNCA de outro writer. Apontar so cria vinculo para o
        // servidor ADOTAR a base quando ela e EXATAMENTE a corrente (V5/V6);
        // se um terceiro avancou, stale normal — nada e promovido.
        const antMeu = filaItem.filter(o => o.op_id && mesmoWriter(o) && !o.bloqueada).sort((a, b) => a.seq - b.seq).pop();
        if (filaItem.some(o => o.op === 'delete')) {
            // Delete pendente: preserva TUDO do item, sem fundir nada.
            op.sucessor_of = antMeu ? antMeu.op_id : null;
        } else if (ant && mesmoWriter(ant)) {
            // Coalesce INTRA-WRITER: funde SOMENTE com a antecessora elegivel
            // mais recente (ant). Ops MAIS ANTIGAS do mesmo writer que
            // sobreviveram a um intercalo de outro writer (A1 B1 A2) sao
            // tentativas PROPRIAS — remover A1 ao fundir A2 seria perda

            op.sucessor_of = ant.sent ? ant.op_id : (ant.sucessor_of || null);
            await req(stOb.delete(kOp(conta, ant.op_id)));
        } else {
            // Outro writer escreveu DEPOIS da minha ultima: NAO fundir (C20),
            // mas o vinculo com a MINHA ultima pendente continua (A1 B1 A2 ->
            // A2 aponta para A1, nunca para B1). Sem isso A2 cairia stale
            // contra a propria historia do writer.
            op.sucessor_of = antMeu ? antMeu.op_id : null;
        }
        // Nada de outro writer e tocado — as tentativas coexistem e o CAS decide.
        await req(stOb.put(op, kOp(conta, op.op_id)));
        await req(stRec.put(m.record, k3(conta, entity, id)));
        await req(stSnap.put([...snap.filter(r => idOf(entity, r) !== id), m.record], kSnap(conta, entity)));
        consumidos.push({ entity, id, token: pin.token });
        return;
    }
    if (!m.id) throw new Error('invalid: delete sem id'); // E2
    const pin = base.peek(entity, m.id);
    const op: SyncOpV2 = { conta, entity, id: m.id, op: 'delete', ts: now, base_v: pin.base, op_id: novoOpId(), sucessor_of: (() => { const am = filaItem.filter(o => o.op_id && mesmoWriter(o)).sort((a, b) => a.seq - b.seq).pop(); return am ? am.op_id : null; })(), seq: await proximaSeq(tx, conta), writer: WRITER_ID };
    await req(stOb.put(op, kOp(conta, op.op_id)));
    await req(stRec.delete(k3(conta, entity, m.id)));
    await req(stSnap.put(snap.filter(r => idOf(entity, r) !== m.id), kSnap(conta, entity)));
    consumidos.push({ entity, id: m.id, token: pin.token });
}

async function aplica(
    db: IDBDatabase, conta: string, entity: string, muts: Mutation[], base: BaseProvider,
): Promise<T1Result> {
    if (!conta) return { ok: false, cause: 'invalid' };
    for (const m of muts) {
        if (m.type === 'upsert' && !idOf(entity, m.record)) return { ok: false, cause: 'invalid' };
        if (m.type === 'delete' && !m.id) return { ok: false, cause: 'invalid' };
    }
    const consumidos: { entity: string; id: string; token: unknown }[] = [];
    try {
        await runTx(db, ['records', 'snap', 'outbox', 'meta'], async (tx) => {
            const now = Date.now();
            for (const m of muts) await mutaRegistro(tx, conta, entity, m, base, now, consumidos);
        });
    } catch (e) {
        const c = classify(e, closedByUpgrade(db));
        return { ok: false, cause: String(e).startsWith('Error: invalid') ? 'invalid' : c };
    }
    for (const c of consumidos) base.consume(c.entity, c.id, c.token); // E4+token: SOMENTE apos commit e so se o pin ainda for o mesmo
    return OK;
}

// Upsert de UM registro (saveTx/saveRec/saveCat/reaplicar conflito).
export function applyRecordUpsert(db: IDBDatabase, conta: string, entity: string, record: Rec, base: BaseProvider): Promise<T1Result> {
    return serial(() => aplica(db, conta, entity, [{ type: 'upsert', record }], base));
}
// Delete de UM registro (deleteTx/deleteRec/desfazer parcial/reaplicar exclusao).
export function applyRecordDelete(db: IDBDatabase, conta: string, entity: string, id: string, base: BaseProvider): Promise<T1Result> {
    return serial(() => aplica(db, conta, entity, [{ type: 'delete', id }], base));
}
// Lote de mutacoes explicitas da MESMA entidade em UMA transacao, na ORDEM dada
// (desfazer-paga multi-item, importacao): nunca despejo de colecao do espelho.
export function applyBulk(db: IDBDatabase, conta: string, entity: string, muts: Mutation[], base: BaseProvider): Promise<T1Result> {
    return serial(() => aplica(db, conta, entity, muts, base));
}

// Leitura da colecao DENTRO de uma transacao existente — usada pelo applyIntent
// para ler e gravar na MESMA tx readwrite (sem janela TOCTOU entre abas).
async function readCollectionTx(tx: IDBTransaction, conta: string, entity: string): Promise<Rec[]> {
    const st = tx.objectStore('records');
    const vals = ((await req<Rec[]>(st.getAll())) ?? []) as Rec[];
    const keys = ((await req<IDBValidKey[]>(st.getAllKeys())) ?? []) as IDBValidKey[];
    const prefix = encodeURIComponent(conta) + '|' + encodeURIComponent(entity) + '|';
    const out: Rec[] = [];
    keys.forEach((k, i) => { if (String(k).startsWith(prefix)) out.push(vals[i]); });
    return out;
}

// Leitura + mutacao na MESMA transacao readwrite. A fn do chamador e a INTENCAO
// explicita (SINCRONA: (fresco) => colecao seguinte) aplicada sobre a colecao
// lida dentro da tx; o diff por registro e a gravacao (registro+op+snap) rodam
// na mesma tx — nenhuma aba grava entre a leitura e a escrita. O espelho da
// aba deve adotar EXATAMENTE o retorno da fn (estado commitado, atomico com a
// base consumida pos-commit).
export function applyIntent(
    db: IDBDatabase, conta: string, entity: string,
    fn: (fresh: Rec[]) => Rec[], base: BaseProvider,
): Promise<T1Result> {
    return serial(async () => {
        if (!conta) return { ok: false, cause: 'invalid' };
        const consumidos: { entity: string; id: string; token: unknown }[] = [];
        try {
            await runTx(db, ['records', 'snap', 'outbox', 'meta'], async (tx) => {
                const fresh = await readCollectionTx(tx, conta, entity);
                const next = fn(fresh);
                const antes = new Map(fresh.map(r => [idOf(entity, r), JSON.stringify(r)]));
                const depois = new Map(next.map(r => [idOf(entity, r), r]));
                const now = Date.now();
                // Ausencia so vira delete quando a fn (intencao) removeu o registro.
                for (const [id, r] of depois) if (antes.get(id) !== JSON.stringify(r)) await mutaRegistro(tx, conta, entity, { type: 'upsert', record: r }, base, now, consumidos);
                for (const id of antes.keys()) if (!depois.has(id)) await mutaRegistro(tx, conta, entity, { type: 'delete', id }, base, now, consumidos);
            });
        } catch (e) {
            const c = classify(e, closedByUpgrade(db));
            return { ok: false, cause: String(e).startsWith('Error: invalid') ? 'invalid' : c };
        }
        for (const c of consumidos) base.consume(c.entity, c.id, c.token); // E4+token: so apos commit
        return OK;
    });
}

// Leituras auxiliares (espelho/boot/testes). NUNCA usadas como base de edicao.
// Ordem de despacho: seq (monotonica por conta).
export async function readOutboxIDB(db: IDBDatabase, conta: string): Promise<SyncOpV2[]> {
    const tx = db.transaction(['outbox'], 'readonly');
    const all = ((await req<SyncOpV2[]>(tx.objectStore('outbox').getAll())) ?? []) as SyncOpV2[];
    return all.filter(o => o.conta === conta).sort((a, b) => a.seq - b.seq);
}
export async function readCollectionIDB(db: IDBDatabase, conta: string, entity: string): Promise<Rec[]> {
    const tx = db.transaction(['records'], 'readonly');
    const vals = ((await req<Rec[]>(tx.objectStore('records').getAll())) ?? []) as Rec[];
    const keys = ((await req<IDBValidKey[]>(tx.objectStore('records').getAllKeys())) ?? []) as IDBValidKey[];
    const prefix = encodeURIComponent(conta) + '|' + encodeURIComponent(entity) + '|';
    const out: Rec[] = [];
    keys.forEach((k, i) => { if (String(k).startsWith(prefix)) out.push(vals[i]); });
    return out;
}


// Cada tentativa recusada e UM registro, chaveado por conta|entity|id|op_id:
// duas recusas no MESMO registro coexistem (C20); escolher uma NAO descarta a
// outra. O oficial apresentado vai congelado no registro (versao vista na
// escolha). Sem motor de veredito nesta fase (T2/T3 em STOP): quem escreve
// conflito hoje e o FIXTURE de ensaio; o veredito do servidor e provado em
// teste de API separado.
export interface ConflictRecordV2 {
    conta: string; entity: string; id: string; op_id: string; // op_id da TENTATIVA recusada
    tentativa: { op: 'upsert' | 'delete'; data?: unknown; ts: number; base_v: number | null };
    oficial: { data?: unknown; version: number | null } | null; // o que o servidor tinha no veredito
    motivo: string; // ex.: 'stale' — causa recusada, para a UI
    ts: number;
}

export async function writeConflictV2(db: IDBDatabase, c: ConflictRecordV2): Promise<T1Result> {
    try {
        await runTx(db, ['conflicts'], async (tx) => {
            await req(tx.objectStore('conflicts').put(c, kConflict(c.conta, c.entity, c.id, c.op_id)));
        });
    } catch (e) { return { ok: false, cause: classify(e, closedByUpgrade(db)) }; }
    return OK;
}

export async function readConflictsIDB(db: IDBDatabase, conta: string): Promise<ConflictRecordV2[]> {
    const tx = db.transaction(['conflicts'], 'readonly');
    const vals = ((await req<ConflictRecordV2[]>(tx.objectStore('conflicts').getAll())) ?? []) as ConflictRecordV2[];
    const keys = ((await req<IDBValidKey[]>(tx.objectStore('conflicts').getAllKeys())) ?? []) as IDBValidKey[];
    const prefix = encodeURIComponent(conta) + '|';
    const out: ConflictRecordV2[] = [];
    keys.forEach((k, i) => { if (String(k).startsWith(prefix)) out.push(vals[i]); });
    return out.sort((a, b) => a.ts - b.ts);
}

// REAPLICAR: a tentativa vira op NOVA — op_id novo, base_v EXATAMENTE a versao
// oficial MOSTRADA na escolha, sucessor_of NULL (a recusada nunca foi aplicada;
// apontar para ela seria recusa certa por antecessor nao aplicado). Se a
// oficial tiver avancado depois da escolha, o servidor recusa de novo e a
// tentativa volta como conflito NOVO — nada e sobrescrito sem veredito. A
// remocao do conflito ORIGEM acontece na MESMA transacao: abort preserva TUDO
// (conflito incluso). As OUTRAS tentativas do mesmo registro nao sao tocadas.
export function applyReapply(db: IDBDatabase, c: ConflictRecordV2): Promise<T1Result> {
    return serial(async () => {
        if (!c.conta || !c.id || !c.op_id) return { ok: false, cause: 'invalid' };
        if (c.tentativa.op === 'upsert' && !idOf(c.entity, c.tentativa.data)) return { ok: false, cause: 'invalid' };
        try {
            await runTx(db, ['records', 'snap', 'outbox', 'conflicts', 'meta'], async (tx) => {
                const now = Date.now();

                // intencao LOCAL pendente do MESMO item na fila (qualquer
                // writer, upsert OU delete — delete e recriacao idem), o
                // reaplicar sobrescreveria essa edicao mais nova em silencio.
                // Bloqueia SEM gravar nada: conflito, op pendente e registro
                // local ficam intactos e o usuario resolve a edicao primeiro.
                // A checagem mora DENTRO da tx — entre a leitura e a gravacao
                // nao entra corrida de outra aba.
                const stObG = tx.objectStore('outbox');
                const opsItem = ((await req<SyncOpV2[]>(stObG.getAll())) ?? []) as SyncOpV2[];
                if (opsItem.some(o => o && o.conta === c.conta && o.entity === c.entity && o.id === c.id)) throw new Error('pendente-guard');
                const baseOficial = c.oficial ? c.oficial.version : null;
                const op: SyncOpV2 = {
                    conta: c.conta, entity: c.entity, id: c.id, op: c.tentativa.op,
                    data: c.tentativa.data, ts: now, base_v: baseOficial,
                    op_id: novoOpId(), sucessor_of: null, seq: await proximaSeq(tx, c.conta), writer: WRITER_ID,
                };
                const stRec = tx.objectStore('records');
                const stSnap = tx.objectStore('snap');
                const snap = ((await req<Rec[] | undefined>(stSnap.get(kSnap(c.conta, c.entity)))) ?? []) as Rec[];
                if (c.tentativa.op === 'upsert') {
                    await req(stRec.put(c.tentativa.data as Rec, k3(c.conta, c.entity, c.id)));
                    await req(stSnap.put([...snap.filter(r => idOf(c.entity, r) !== c.id), c.tentativa.data as Rec], kSnap(c.conta, c.entity)));
                } else {
                    await req(stRec.delete(k3(c.conta, c.entity, c.id)));
                    await req(stSnap.put(snap.filter(r => idOf(c.entity, r) !== c.id), kSnap(c.conta, c.entity)));
                }
                await req(tx.objectStore('outbox').put(op, kOp(c.conta, op.op_id)));
                await req(tx.objectStore('conflicts').delete(kConflict(c.conta, c.entity, c.id, c.op_id)));
            });
        } catch (e) {
            if (e instanceof Error && e.message === 'pendente-guard') return { ok: false, cause: 'pendente' };
            return { ok: false, cause: classify(e, closedByUpgrade(db)) };
        }
        return OK;
    });
}


// (1) GUARDA anti-overwrite: intencao pendente NAO bloqueada do MESMO item
//     (qualquer writer, upsert ou delete) -> aborta SEM gravar nada; a intencao
//     mais nova E a tentativa recusada ficam intactas ('pendente').
// (2) Op corrigida entra pelo MESMO mutaRegistro do save normal (coalesce,
//     linhagem, base pin consumido so pos-commit) + remocao da tentativa
//     recusada na MESMA tx — sem janela entre save e descarte.
// (3) Paridade (nada mudou em relacao ao snap): mutaRegistro NAO gera op —
//     entao a recusada NAO e removida (a tentativa segue preservada; remover
//     sem op nova perderia a intencao, porque o oficial nao tem o dado).
export function applyCorrigeBloqueada(db: IDBDatabase, conta: string, entity: string, record: Rec, bloqueadaOpId: string, base: BaseProvider): Promise<T1Result> {
    return serial(async () => {
        if (!conta || !bloqueadaOpId) return { ok: false, cause: 'invalid' };
        const id = idOf(entity, record);
        if (!id) return { ok: false, cause: 'invalid' };
        const consumidos: { entity: string; id: string; token: unknown }[] = [];
        let paridade = false;
        try {
            await runTx(db, ['records', 'snap', 'outbox', 'meta'], async (tx) => {
                const stOb = tx.objectStore('outbox');
                const fila = ((await req<SyncOpV2[]>(stOb.getAll())) ?? []) as SyncOpV2[];
                if (fila.some(o => o.conta === conta && o.entity === entity && o.id === id && !o.bloqueada)) throw new Error('pendente-guard');
                const alvo = fila.find(o => o.conta === conta && o.op_id === bloqueadaOpId);
                if (!alvo || !alvo.bloqueada) throw new Error('invalid'); // ja resolvida por outra acao: nada a corrigir
                const antes = consumidos.length;
                await mutaRegistro(tx, conta, entity, { type: 'upsert', record }, base, Date.now(), consumidos);
                if (consumidos.length > antes) await req(stOb.delete(kOp(conta, bloqueadaOpId)));
                else paridade = true; // nada mudou: recusada FICA (invariante 3)
            });
        } catch (e) {
            if (e instanceof Error && e.message === 'pendente-guard') return { ok: false, cause: 'pendente' };
            const c = classify(e, closedByUpgrade(db));
            return { ok: false, cause: String(e).startsWith('Error: invalid') ? 'invalid' : c };
        }
        for (const c of consumidos) base.consume(c.entity, c.id, c.token); // E4+token: so apos commit e so o MESMO pin
        return paridade ? { ok: true, cause: 'paridade' } : OK;
    });
}

// DESCARTAR: veredito terminal da TENTATIVA — remove SOMENTE o registro dela.
export function discardConflictV2(db: IDBDatabase, c: ConflictRecordV2): Promise<T1Result> {
    return serial(async () => {
        if (!c.conta || !c.id || !c.op_id) return { ok: false, cause: 'invalid' };
        try {
            await runTx(db, ['conflicts'], async (tx) => {
                await req(tx.objectStore('conflicts').delete(kConflict(c.conta, c.entity, c.id, c.op_id)));
            });
        } catch (e) { return { ok: false, cause: classify(e, closedByUpgrade(db)) }; }
        return OK;
    });
}
