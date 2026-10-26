

// hidratacao /api/state, SOMENTE atras da flag de ensaio E de meta 'motor'='on',
// com contas ficticias e servidor de teste. NUNCA le/escreve
// localStorage/sessionStorage v1 nem a fila v1. Sem migracao.
//

// (a) Veredito em UMA tx IDB: a op so sai da fila JUNTO com o resultado gravado
//     (oficial+registro recomputado ou conflito). Falha de gravacao (quota) -> a
//     op FICA. Resposta perdida -> reenvio do MESMO op_id; a dedupe resolve.
// (b) Hidratacao NAO apaga pendencia e NAO REGRIDE oficial: fetch e aplicacao
//     rodam NA CADEIA do motor (serializada com o flush DESTA aba); a resposta
//     carrega serverTime e e DESCARTADA INTEIRA dentro da tx se for mais antiga
//     que o ultimo veredito/hidratacao aplicados (epoch 'stateAsOf'); por
//     registro, versao so avanca (monotonicidade, com TOMBSTONE local: delete
//     oficial nao apaga o marcador — snapshot velho nao ressuscita item).
//     Ausencia vira delete local SOMENTE de quem ERA oficial (protocolo so manda
//     nao-deletados) e sem intencao pendente — vira tombstone, nao sumico.
// (c) Versoes oficiais persistentes por conta no IDB (meta 'oficial|...'); o
//     base pin vem da versao que ESTA ABA renderizou (v2store.espelhoVers),
//     nunca de mapa avancado por outra aba.
// (d) Sem lock entre abas (verificado na bancada, nao assumido): aplicacao por
//     op_id idempotente; tx readwrite IDB serializa entre conexoes; replay
//     memoizado NUNCA regride (monotonicidade + epoch).
// (e) 'rejected' (estado do servidor, NAO memoizado): a op FICA na fila,
//     MARCADA bloqueada com o motivo, e NUNCA e reenviada sozinha — so acao
//     explicita (nova edicao do item ou desbloqueio). Sem descarte silencioso.

//     'invalid' (terminal): conflito proprio (motivo 'invalid') + op removida.
// (f) Marcacao de despacho ('sent') NUNCA ressuscita op: relê por chave DENTRO
//     da tx e so marca as que ainda existem (coalesce pode ter removido).
// (g) Correlacao de vereditos: por op_id; o caminho 'invalid' estrutural do
//     servidor NAO ecoa op_id — correlacao por (entity,id,ts) SOMENTE se UNICA;
//     ambigua ou ausente: fail closed (candidatas bloqueadas com causa honesta),
//     NUNCA perda nem retry infinito.
// (h) Epoch de conta: a conta e CAPTURADA no inicio do flush/hidratacao e usada
//     em todas as chaves e validacoes; 401/409 encerram o motor (para()), fila
//     intacta. Troca de conta sem reload: fora (sem segunda conta no ensaio).

import { openMF, runTx, req, k3, kSnap, kOp, kMeta, kConflict, kOficial, prefixOficial } from './db';
import type { SyncOpV2, ConflictRecordV2 } from './syncIDB';
import { readOutboxIDB } from './syncIDB';
import { v2Db, v2IsActive, v2Conta, v2RefreshEspelho, v2Poke, v2SetPosCommit } from './v2store';

type Rec = Record<string, unknown>;
type Veredito = {
    entity: string; id: string; ts?: number; op_id?: string; status: string;
    version?: number; server?: unknown; deleted?: boolean; updated_at?: number; error?: string;
};
// Oficial persistido: tombstone local quando o servidor apagou (version = ultima

type Oficial = { data: Rec | null; version: number | null; deleted?: boolean };

const ENTIDADES = ['tx', 'cat', 'rec', 'catrule'] as const;
const idOf = (entity: string, r: unknown): string => {
    if (!r || typeof r !== 'object') return '';
    const o = r as Rec;
    return String(entity === 'catrule' ? (o.key ?? '') : (o.id ?? ''));
};

let rodando = false;
let contaMotor = '';
let flushing = false;
let pausado = false; // controle de TESTE: __v2motorPausa (so gatilhos automaticos)
let timer: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let aviso: string | null = null;
let avisoRejeicao = false;
let pendentes = 0;

const defineAviso = (a: string | null): void => { aviso = a; v2Poke(); };
export function v2MotorAviso(): string | null { return aviso; }
export function v2MotorStatus(): { rodando: boolean; flushing: boolean; pausado: boolean; pendentes: number; aviso: string | null } {
    return { rodando, flushing, pausado, pendentes, aviso };
}

// CADEIA do motor: serializa flush e hidratacao DESTA aba, cobrindo fetch +
// aplicacao inteiros — uma resposta antiga nunca se intercala com vereditos
// novos NESTA aba (entre abas: epoch in-tx + monotonicidade). Sem deadlock:
// nenhuma etapa enfileira E espera outra; pos-flush dispara hidratacao sem await.
let cadeiaMotor: Promise<unknown> = Promise.resolve();
function enfileira<T>(fn: () => Promise<T>): Promise<T> {
    const p = cadeiaMotor.then(fn, fn);
    cadeiaMotor = p.catch(() => { /* erro ja entregue */ });
    return p;
}

// ---------- HIDRATACAO ----------
async function hidrataImpl(): Promise<boolean> {
    const db = v2Db();
    if (!db || !v2IsActive()) return false;
    const conta = v2Conta(); // epoch de conta capturada (h)
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (res.status === 401) { para('Sessão encerrada. Entre de novo.'); return false; }
    if (!res.ok) { defineAviso('Sem conexão com o servidor de teste.'); return false; }
    const body = await res.json() as { serverTime?: number; records?: Record<string, Rec[]>; versions?: Record<string, Record<string, number>>; username?: string };
    if (body.username && body.username.trim().toLowerCase() !== conta) { para('A conta mudou neste aparelho. Entre de novo.'); return false; }
    const stamp = typeof body.serverTime === 'number' ? body.serverTime : 0;
    let aplicou = false;
    // UMA tx para as 4 colecoes. O epoch e checado DENTRO da tx: serializa com
    // os vereditos das OUTRAS abas — resposta mais antiga que o ultimo resultado
    // aplicado e descartada INTEIRA (nada regride).
    await runTx(db, ['records', 'snap', 'outbox', 'meta'], async (tx) => {
        const stRec = tx.objectStore('records');
        const stSnap = tx.objectStore('snap');
        const stOb = tx.objectStore('outbox');
        const stMeta = tx.objectStore('meta');
        const asOf = ((await req<number | undefined>(stMeta.get(kMeta(conta, 'stateAsOf')))) ?? 0);
        if (stamp < asOf) return; // snapshot ANTIGA: fora
        const opsTodas = (((await req<SyncOpV2[]>(stOb.getAll())) ?? []) as SyncOpV2[]).filter(o => o.conta === conta);
        for (const e of ENTIDADES) {
            const serverRecs = body.records?.[e] ?? [];
            const serverVers = body.versions?.[e] ?? {};
            const mapa = new Map<string, Rec>();
            const veio = new Set<string>();
            for (const r of serverRecs) {
                const id = idOf(e, r);
                if (!id) continue;
                const vServ = typeof serverVers[id] === 'number' ? serverVers[id] : null;
                // Monotonicidade por registro (com tombstone): nunca regride,
                // snapshot velho nao ressuscita item apagado depois do snapshot.
                const local = (await req<Oficial | undefined>(stMeta.get(kOficial(conta, e, id))));
                if (local && typeof local.version === 'number' && vServ !== null && vServ < local.version || local && local.deleted && typeof local.version === 'number' && vServ !== null && vServ === local.version) {
                    // Versao MENOR ignorada: o item VEIO na snapshot (presenca
                    // reconhecida em `veio`) mas o dado local mais novo FICA —
                    // ignorar versao menor NUNCA pode virar ausencia/tombstone

                    veio.add(id);
                    if (!local.deleted && local.data) mapa.set(id, local.data); // dado local mais novo FICA no registro
                    continue;
                }
                veio.add(id);
                mapa.set(id, r);
                await req(stMeta.put({ data: r, version: vServ }, kOficial(conta, e, id)));
            }
            // Oficial APAGADO no servidor: era oficial local (nao tombstone) e
            // nao veio na snapshot FRESCA (epoch garantido) -> TOMBSTONE local.
            const chavesMeta = ((await req<IDBValidKey[]>(stMeta.getAllKeys())) ?? []) as IDBValidKey[];
            const pre = prefixOficial(conta, e);
            for (const k of chavesMeta) {
                const ks = String(k);
                if (!ks.startsWith(pre)) continue;
                const idDec = decodeURIComponent(ks.slice(pre.length));
                if (veio.has(idDec)) continue;
                const local = (await req<Oficial | undefined>(stMeta.get(ks)));
                if (local && !local.deleted) await req(stMeta.put({ data: null, version: local.version ?? null, deleted: true }, ks));
            }
            // Replay das pendencias por cima do oficial (ordem de despacho: seq).
            // BLOQUEADA (rejected) nao entra no replay: a tentativa recusada fica
            // preservada na fila com o motivo, mas NAO mascara o oficial.
            const ops = opsTodas.filter(o => o.entity === e && !o.bloqueada).sort((a, b) => a.seq - b.seq);
            for (const o of ops) {
                if (o.op === 'upsert') mapa.set(o.id, (o.data ?? {}) as Rec);
                else mapa.delete(o.id);
            }
            const chavesRec = ((await req<IDBValidKey[]>(stRec.getAllKeys())) ?? []) as IDBValidKey[];
            const preRec = encodeURIComponent(conta) + '|' + encodeURIComponent(e) + '|';
            for (const k of chavesRec) {
                const ks = String(k);
                if (!ks.startsWith(preRec)) continue;
                const idDec = decodeURIComponent(ks.slice(preRec.length));
                if (!mapa.has(idDec)) await req(stRec.delete(ks));
            }
            for (const [id, r] of mapa) await req(stRec.put(r, k3(conta, e, id)));
            await req(stSnap.put([...mapa.values()], kSnap(conta, e)));
        }
        if (stamp > asOf) await req(stMeta.put(stamp, kMeta(conta, 'stateAsOf')));
        aplicou = true;
    });
    if (aplicou) await v2RefreshEspelho();
    return aplicou;
}
function hidrata(): Promise<boolean> { return enfileira(hidrataImpl); }

// ---------- VEREDITO (UMA tx por op: op so sai com resultado gravado) ----------
async function recomputaItem(tx: IDBTransaction, conta: string, entity: string, id: string): Promise<void> {
    const stRec = tx.objectStore('records');
    const stSnap = tx.objectStore('snap');
    const stOb = tx.objectStore('outbox');
    const stMeta = tx.objectStore('meta');
    const oficial = (await req<Oficial | undefined>(stMeta.get(kOficial(conta, entity, id))));
    let estado: Rec | null = (oficial && !oficial.deleted && oficial.data) ? oficial.data : null;
    const ops = (((await req<SyncOpV2[]>(stOb.getAll())) ?? []) as SyncOpV2[])
        .filter(o => o.conta === conta && o.entity === entity && o.id === id && !o.bloqueada)
        .sort((a, b) => a.seq - b.seq);
    for (const o of ops) estado = o.op === 'upsert' ? ((o.data ?? {}) as Rec) : null;
    if (estado) await req(stRec.put(estado, k3(conta, entity, id)));
    else await req(stRec.delete(k3(conta, entity, id)));
    const snap = ((await req<Rec[] | undefined>(stSnap.get(kSnap(conta, entity)))) ?? []) as Rec[];
    const sem = snap.filter(r => idOf(entity, r) !== id);
    await req(stSnap.put(estado ? [...sem, estado] : sem, kSnap(conta, entity)));
}

// contaEpoch: conta capturada no INICIO do flush (h) — nunca rele v2Conta().
async function aplicaVeredito(v: Veredito, enviadas: SyncOpV2[], contaEpoch: string): Promise<boolean> {
    const db = v2Db();
    if (!db || !v2IsActive()) return false;
    // Entidade desconhecida (op bruta/versao futura): NUNCA processar nem
    // retentar em laco — cai no MESMO fail closed da correlacao ambigua (t18).
    const entidadeOk = ENTIDADES.includes(v.entity as typeof ENTIDADES[number]);
    // Correlacao (g): op_id primeiro; sem op_id, (entity,id,ts) SOMENTE se unico.
    let opId = entidadeOk && typeof v.op_id === 'string' && v.op_id ? v.op_id : null;
    if (!opId) {
        const cand = enviadas.filter(o => o.entity === v.entity && o.id === v.id && o.ts === v.ts);
        if (entidadeOk && cand.length === 1) opId = cand[0].op_id;
        else {
            // FAIL CLOSED: nada e perdido nem retentado em laco — as candidatas
            // ficam bloqueadas com causa honesta ate acao explicita.
            const alvos = cand.length ? cand : enviadas.filter(o => o.entity === v.entity && o.id === v.id);
            const causa = entidadeOk
                ? 'O servidor recusou sem identificar a operação.'
                : 'O servidor recusou: tipo de registro não reconhecido por esta versão do app.';
            await runTx(db, ['outbox'], async (tx) => {
                for (const c of alvos) {
                    const atual = await req<SyncOpV2 | undefined>(tx.objectStore('outbox').get(kOp(contaEpoch, c.op_id)));
                    if (atual) await req(tx.objectStore('outbox').put({ ...atual, bloqueada: causa }, kOp(contaEpoch, c.op_id)));
                }
            });
            avisoRejeicao = true;
            defineAviso('O servidor recusou uma alteração sem identificar qual. Ela ficou guardada neste aparelho e não será reenviada sozinha.');
            return false;
        }
    }
    const opIdFinal = opId;
    let mudou = false;
    await runTx(db, ['records', 'snap', 'outbox', 'conflicts', 'meta'], async (tx) => {
        const stOb = tx.objectStore('outbox');
        const stMeta = tx.objectStore('meta');
        const stConf = tx.objectStore('conflicts');
        const op = await req<SyncOpV2 | undefined>(stOb.get(kOp(contaEpoch, opIdFinal)));
        if (!op || op.conta !== contaEpoch) return; // outra aba ja aplicou (idempotente)
        const kOf = kOficial(op.conta, op.entity, op.id);
        const oficialAtual = (await req<Oficial | undefined>(stMeta.get(kOf)));
        const versaoAtual = oficialAtual && typeof oficialAtual.version === 'number' ? oficialAtual.version : -1;
        const versaoNova = typeof v.version === 'number' ? v.version : -1;
        const avanca = versaoNova >= versaoAtual; // replay atrasado NUNCA regride
        if (v.status === 'applied' || v.status === 'skipped') {
            await req(stOb.delete(kOp(contaEpoch, op.op_id)));
            if (op.op === 'upsert') {
                const dados = v.status === 'skipped' && v.server ? (v.server as Rec) : (op.data as Rec);
                if (avanca && dados) await req(stMeta.put({ data: dados, version: versaoNova >= 0 ? versaoNova : null }, kOf));
            } else {
                // delete aplicado (sem versao no contrato): TOMBSTONE local se o
                // oficial ainda for o da base — delete atrasado nao regride.
                const baseDel = typeof op.base_v === 'number' ? op.base_v : -1;
                if (!oficialAtual || !oficialAtual.deleted && versaoAtual <= baseDel) {
                    await req(stMeta.put({ data: null, version: baseDel >= 0 ? baseDel : (versaoAtual >= 0 ? versaoAtual : null), deleted: true }, kOf));
                }
            }
            mudou = true;
        } else if (v.status === 'stale' || v.status === 'invalid') {
            const oficialConflito = v.status === 'stale'
                ? (v.deleted ? null : { data: v.server, version: typeof v.version === 'number' ? v.version : null })
                : (oficialAtual && !oficialAtual.deleted ? { data: oficialAtual.data, version: oficialAtual.version } : null);
            const c: ConflictRecordV2 = {
                conta: op.conta, entity: op.entity, id: op.id, op_id: op.op_id,
                tentativa: { op: op.op, data: op.data, ts: op.ts, base_v: op.base_v ?? null },
                oficial: oficialConflito as ConflictRecordV2['oficial'],
                motivo: v.status, ts: Date.now(),
            };
            await req(stConf.put(c, kConflict(op.conta, c.entity, c.id, c.op_id)));
            await req(stOb.delete(kOp(contaEpoch, op.op_id)));
            if (v.status === 'stale' && avanca) {
                if (v.deleted) await req(stMeta.put({ data: null, version: versaoNova >= 0 ? versaoNova : null, deleted: true }, kOf));
                else if (v.server) await req(stMeta.put({ data: v.server as Rec, version: versaoNova >= 0 ? versaoNova : null }, kOf));
            }
            mudou = true;
        } else if (v.status === 'rejected') {
            // Op FICA, marcada bloqueada com o motivo (mesma tx): NUNCA reenvio
            // automatico — so acao explicita (nova edicao ou desbloqueio).
            await req(stOb.put({ ...op, bloqueada: String(v.error || 'O servidor recusou.') }, kOp(contaEpoch, op.op_id)));
            avisoRejeicao = true;
            defineAviso((v.error ? String(v.error) + ' ' : '') + 'A alteração ficou guardada neste aparelho e não será reenviada sozinha.');
        }
        if (mudou) await recomputaItem(tx, op.conta, op.entity, op.id);
    });
    if (mudou) await v2RefreshEspelho();
    return mudou;
}

// ---------- FLUSH ----------
async function flushImpl(): Promise<void> {
    const db = v2Db();
    if (!db || !v2IsActive()) return;
    flushing = true;
    try {
        const conta = v2Conta(); // epoch de conta CAPTURADA (h)
        const todas = await readOutboxIDB(db, conta);
        const ops = todas.filter(o => !o.bloqueada); // bloqueadas NUNCA voltam sozinhas
        pendentes = todas.length;
        // Nada a enviar MAS ha bloqueada (outra aba, injecao, ciclo anterior):
        // a UI precisa do banner mesmo sem veredito novo neste flush.
        if (!ops.length) { if (todas.some(o => o.bloqueada)) await v2RefreshEspelho(); return; }
        // Marca 'sent' SEM ressuscitar (f): rele por chave DENTRO da tx e so
        // marca quem ainda existe; o lote enviado e o efetivamente marcado.
        const enviadas: SyncOpV2[] = [];
        await runTx(db, ['outbox'], async (tx) => {
            const st = tx.objectStore('outbox');
            for (const o of ops) {
                const atual = await req<SyncOpV2 | undefined>(st.get(kOp(conta, o.op_id)));
                if (!atual) continue; // coalescida/removida entre a leitura e a marca
                await req(st.put({ ...atual, sent: true }, kOp(conta, o.op_id)));
                enviadas.push(atual);
            }
        });
        if (!enviadas.length) return;
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                device: 'v2-ensaio',
                username: conta,
                ops: enviadas.map(o => ({ op_id: o.op_id, ts: o.ts, entity: o.entity, id: o.id, op: o.op, data: o.data ?? null, base_v: o.base_v ?? null, sucessor_of: o.sucessor_of ?? null })),
            }),
        });
        if (res.status === 401) { para('Sessão encerrada. Entre de novo.'); return; }
        if (res.status === 409) { para('A conta mudou neste aparelho. Entre de novo para sincronizar.'); return; } // epoch encerrada: PARA, fila intacta
        if (!res.ok) { defineAviso('Sem conexão com o servidor de teste. As alterações continuam neste aparelho.'); return; }
        const body = await res.json() as { serverTime?: number; results?: Veredito[]; username?: string };
        if (body.username && body.username.trim().toLowerCase() !== conta) { para('A conta mudou neste aparelho. Entre de novo.'); return; }
        const results = body.results ?? [];
        let aplicou = 0;
        for (const v of results) {
            try { if (await aplicaVeredito(v, enviadas, conta)) aplicou++; }
            catch (e) { defineAviso(e && typeof e === 'object' && (e as { name?: unknown }).name === 'QuotaExceededError' ? 'Armazenamento cheio. A alteração continua na fila.' : 'Falha ao gravar o resultado. A alteração continua na fila.'); }
        }
        // Epoch do lote: o serverTime da resposta marca o corte conhecido.
        if (typeof body.serverTime === 'number') {
            await runTx(db, ['meta'], async (tx) => {
                const st = tx.objectStore('meta');
                const cur = ((await req<number | undefined>(st.get(kMeta(conta, 'stateAsOf')))) ?? 0);
                if (body.serverTime! > cur) await req(st.put(body.serverTime, kMeta(conta, 'stateAsOf')));
            });
        }
        const resto = await readOutboxIDB(db, conta);
        pendentes = resto.length;
        if (avisoRejeicao && !resto.some(o => o.bloqueada)) { avisoRejeicao = false; defineAviso(null); }
        // Bloqueada nova aparece para a UI (corrigir/descartar) no MESMO ciclo.
        if (resto.some(o => o.bloqueada)) await v2RefreshEspelho();
        // Hidratacao pos-flush SEM await na propria cadeia (sem deadlock): roda
        // na posicao seguinte — absorve mudancas de outras abas/dispositivos.
        if (aplicou > 0) void hidrata();
    } catch {
        // Rede/abort antes ou depois do servidor processar: nada e tocado; as
        // ops ficam e o proximo flush reenvia os MESMOS op_ids (dedupe resolve).
        defineAviso('Sem conexão com o servidor de teste. As alterações continuam neste aparelho.');
    } finally {
        flushing = false;
    }
}
function flush(): Promise<void> { return enfileira(flushImpl); }

function para(msg?: string): void {
    rodando = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (debounce) { clearTimeout(debounce); debounce = null; }
    window.removeEventListener('online', aoOnline);
    v2SetPosCommit(null);
    if (msg) defineAviso(msg);
}

const aoOnline = (): void => { void ciclo(); };
async function ciclo(): Promise<void> {
    if (!rodando || pausado || !v2IsActive() || v2Conta() !== contaMotor) return;
    await flush();
    await hidrata();
}

const agendaFlush = (): void => {
    if (!rodando || pausado) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { void flush(); }, 300);
};

// Inicia o motor DESTA aba. So roda com a flag v2 E meta 'motor'='on' (ensaio).
export async function v2MotorStart(conta: string): Promise<boolean> {
    const db = v2Db();
    if (!db || !v2IsActive()) return false;
    try {
        const tx = db.transaction(['meta'], 'readonly');
        const flag = await req<unknown>(tx.objectStore('meta').get(kMeta(conta, 'motor')));
        if (flag !== 'on') return false;
    } catch { return false; }
    if (rodando && contaMotor === conta) return true;
    para();
    rodando = true;
    contaMotor = conta;
    pausado = false;
    aviso = null;
    avisoRejeicao = false;
    v2SetPosCommit(agendaFlush);
    window.addEventListener('online', aoOnline);
    await hidrata();
    await flush();
    timer = setInterval(() => { void ciclo(); }, 20000);
    return true;
}

export function v2MotorStop(): void { para(); }

// ---------- ganchos de TESTE (rotulados; o app nao chama) ----------
export async function v2MotorLigar(conta: string, on: boolean): Promise<void> {
    const d = await openMF(); // conexao propria: funciona ANTES do boot (setup do ensaio)
    await runTx(d, ['meta'], async (tx) => { await req(tx.objectStore('meta').put(on ? 'on' : 'off', kMeta(conta, 'motor'))); });
    d.close();
}
export async function v2MotorFlushAgora(): Promise<void> { await flush(); } // manual: passa mesmo pausado
export async function v2MotorHidrataAgora(): Promise<void> { await hidrata(); }
export function v2MotorPausa(p: boolean): void { pausado = p; }
// ACAO EXPLICITA (ensaio): desbloqueia UMA op recusada para o proximo flush.
// Gancho rotulado de teste; o affordance de UI proprio e gap declarado.
export async function v2MotorDesbloqueia(opId: string): Promise<boolean> {
    const d = v2Db();
    if (!d || !v2IsActive()) return false;
    const conta = v2Conta();
    let ok = false;
    await runTx(d, ['outbox'], async (tx) => {
        const op = await req<SyncOpV2 | undefined>(tx.objectStore('outbox').get(kOp(conta, opId)));
        if (!op || !op.bloqueada) return;
        const sem = { ...op }; delete sem.bloqueada;
        await req(tx.objectStore('outbox').put(sem, kOp(conta, opId)));
        ok = true;
    });
    if (ok) await v2RefreshEspelho();
    return ok;
}
// ACAO EXPLICITA (ensaio): descarta UMA op recusada. A tentativa sai da fila;
// o oficial NUNCA e tocado — bloqueada ja nao mascara o oficial nem entra no
// replay, entao nada muda no que a pessoa ve alem do aviso/banner.
export async function v2MotorDescartarBloqueada(opId: string): Promise<boolean> {
    const d = v2Db();
    if (!d || !v2IsActive()) return false;
    const conta = v2Conta();
    let ok = false;
    await runTx(d, ['outbox'], async (tx) => {
        const op = await req<SyncOpV2 | undefined>(tx.objectStore('outbox').get(kOp(conta, opId)));
        if (!op || !op.bloqueada) return;
        await req(tx.objectStore('outbox').delete(kOp(conta, opId)));
        ok = true;
    });
    if (ok) {
        const resto = await readOutboxIDB(d, conta);
        pendentes = resto.length;
        if (avisoRejeicao && !resto.some(o => o.bloqueada)) { avisoRejeicao = false; defineAviso(null); }
        await v2RefreshEspelho();
    }
    return ok;
}
// Injecao de op BRUTA na fila (teste dos caminhos 'invalid'/rejected): grava
// exatamente o objeto dado, sem passar por applyIntent. Rotulada de teste.
export async function v2MotorOpBruta(op: SyncOpV2): Promise<void> {
    const d = await openMF(); // conexao propria: nao depende do boot (teste)
    await runTx(d, ['outbox'], async (tx) => { await req(tx.objectStore('outbox').put(op, kOp(op.conta, op.op_id))); });
    d.close();
}
(window as unknown as Record<string, unknown>).__v2motor = v2MotorLigar;
(window as unknown as Record<string, unknown>).__v2motorFlush = v2MotorFlushAgora;
(window as unknown as Record<string, unknown>).__v2motorHidrata = v2MotorHidrataAgora;
(window as unknown as Record<string, unknown>).__v2motorPausa = v2MotorPausa;
(window as unknown as Record<string, unknown>).__v2motorStatus = v2MotorStatus;
(window as unknown as Record<string, unknown>).__v2motorDesbloqueia = v2MotorDesbloqueia;
(window as unknown as Record<string, unknown>).__v2motorOpBruta = v2MotorOpBruta;
