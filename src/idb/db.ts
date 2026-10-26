// Camada IndexedDB (v2) — NUCLEO T1 + contrato async. Desenho: tarefa3-camada-idb.md + delta-v2.

// versionchange sinalizado, chaves com segmentos codificados (sem colisao por '|').
// Ainda NAO ha: T2 (commit oficial), migracao, flag de formato. Modulo isolado —
// nenhum arquivo do app v1 importa isto nesta fase.

export const DB_NAME = 'mf';
export const DB_VERSION = 1;

// Conexoes fechadas por versionchange: NUNCA retentar — o chamador avisa
// "app atualizado em outra aba; recarregue" (sem loop de retry).
const fechadasPorUpgrade = new WeakSet<IDBDatabase>();
export const closedByUpgrade = (db: IDBDatabase): boolean => fechadasPorUpgrade.has(db);

export function openMF(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            for (const s of ['records', 'snap', 'outbox', 'conflicts', 'meta']) {
                if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
            }
        };
        let blocked = false;
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { fechadasPorUpgrade.add(db); db.close(); };
            if (blocked) { db.close(); return; } // open pendente resolveu tarde: fecha a conexao orfa
            resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error('idb open'));
        req.onblocked = () => { blocked = true; reject(new Error('idb blocked')); };
    });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error ?? new Error('idb req')); });
}

// Roda work() dentro de UMA transacao readwrite. Await de requests e seguro no
// Chromium (microtasks mantem a tx ativa; A VERIFICAR por motor fora dele).
// O ERRO ORIGINAL (DOMException) e preservado para o chamador discriminar a causa.
export async function runTx(db: IDBDatabase, stores: string[], work: (tx: IDBTransaction) => Promise<void> | void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        let tx: IDBTransaction;
        try { tx = db.transaction(stores, 'readwrite'); }
        catch (e) { reject(e); return; } // conexao fechada (InvalidStateError) etc.
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('tx abort'));
        tx.onerror = () => { /* o abort segue o erro */ };
        Promise.resolve()
            .then(() => work(tx))
            .catch(e => { try { tx.abort(); } catch { /* ja abortada */ } reject(e); });
    });
}

// Segmentos de chave codificados: encodeURIComponent e injetivo — conta/entidade/id
// com '|', '%' ou qualquer caractere nao colidem nem quebram o prefixo.
const seg = (s: string): string => encodeURIComponent(s);
export const k3 = (conta: string, entity: string, id: string): string => seg(conta) + '|' + seg(entity) + '|' + seg(id);
export const kSnap = (conta: string, entity: string): string => seg(conta) + '|' + seg(entity);
export const kOp = (conta: string, opId: string): string => seg(conta) + '|' + seg(opId);
export const kMeta = (conta: string, chave: string): string => seg(conta) + '|' + seg(chave);
// Estado OFICIAL por item (motor): meta chave 'oficial|entity|id' -> { data, version }.
// Persistente por conta; o base pin da aba vem da versao que ESTA aba renderizou

export const kOficial = (conta: string, entity: string, id: string): string => seg(conta) + '|' + seg('oficial|' + entity + '|' + id);
export const prefixOficial = (conta: string, entity: string): string => seg(conta) + '|' + seg('oficial|' + entity + '|');
// Conflito por TENTATIVA (C20): cada tentativa recusada tem registro proprio —

export const kConflict = (conta: string, entity: string, id: string, opId: string): string => seg(conta) + '|' + seg(entity) + '|' + seg(id) + '|' + seg(opId);

export type T1Cause = 'quota' | 'invalid' | 'closed' | 'error' | 'pendente' | 'paridade';
export interface T1Result { ok: boolean; cause: T1Cause | null }
export const OK: T1Result = { ok: true, cause: null };

// InvalidStateError sozinho pode vir de outras causas — vira 'error', nao "recarregue".
export function classify(e: unknown, fechadaPorUpgrade = false): T1Cause {
    if (fechadaPorUpgrade) return 'closed';
    const name = (e && typeof e === 'object' && 'name' in e) ? String((e as { name?: unknown }).name) : '';
    if (name === 'QuotaExceededError') return 'quota';
    // TransactionInactiveError NAO e 'closed': indica bug (tx encerrada por await
    // de trabalho nao-IDB) — classificado 'error' para nao virar "recarregue" falso.
    return 'error';
}

export { req };
