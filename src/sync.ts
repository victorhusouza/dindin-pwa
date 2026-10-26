// Cliente de sync offline-first contra a API da VM.
// O aparelho continua mandando no proprio estado (localStorage): cada gravacao
// vira operacao numa fila (outbox) que descarrega quando ha internet. Na abertura
// do app, o estado da VM hidrata o aparelho antes da interface renderizar; em
// conflito, a versao mais nova (ultima edicao) vence. A VM e a fonte da verdade.

export interface SyncOp { entity: string; id: string; op: 'upsert' | 'delete'; data?: unknown; ts: number; base_v?: number | null; op_id?: string; sucessor_of?: string | null; sent?: boolean }

const TXS_CHUNKS = 32;
const CHUNK_CAP = 50000;
const OUTBOX_LEGACY_KEY = 'mf.sync.outbox';
const OUTBOX_QUARANTINE_KEY = 'mf.sync.outbox.quarentena';
const OUTBOX_USER_PREFIX = 'mf.sync.outbox.u.';
const SNAP_PREFIX = 'mf.sync.snap.';
const DEVICE_KEY = 'mf.device';

// Chaves do app que viram colecoes sincronizadas. mf.txs.* (fatias) = entidade tx.
const COLLECTIONS: Record<string, { entity: string }> = {
    'mf.cats.v1': { entity: 'cat' },
    'mf.recs.v1': { entity: 'rec' },
    'mf.catrules.v1': { entity: 'catrule' },
};
const TXS_PREFIX = 'mf.txs.';

// Dados locais TAMBEM sao por conta: duas contas no mesmo navegador nao se
// sobrescrevem (nem dados, nem snapshots). As chaves antigas SEM sufixo de
// conta ficam intactas — preservadas inertes, nunca lidas nem enviadas.
function uSuf(): string { return '.u.' + (syncUser || '_'); }
export function txKey(i: number): string { return 'mf.txs' + uSuf() + '.' + i; }
export function colKey(base: string): string { return base + uSuf(); }
export function getSyncUser(): string { return syncUser; }
function snapKey(entity: string): string { return SNAP_PREFIX + 'u.' + (syncUser || '_') + '.' + entity; }

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

// A fila e POR CONTA: cada usuario logado descarrega so a propria. Sem isso,
// a fila de quem saiu ia junto no login da proxima conta (escrita cruzada).
let syncUser = '';
export function setSyncUser(username: string | null): void {
    const novo = (username || '').trim().toLowerCase();
    if (novo !== syncUser) verCache = null; // conta trocou: mapa de versoes e por conta
    syncUser = novo;
    if (syncUser) quarantineLegacyOutbox();
}
function outboxKey(): string { return OUTBOX_USER_PREFIX + (syncUser || '_'); }

// Fila antiga (de antes da separacao por conta) nao tem dono registrado: vai
// para a quarentena, preservada e bloqueada — nunca enviada automaticamente.
function quarantineLegacyOutbox(): void {
    let raw: string | null = null;
    try { raw = localStorage.getItem(OUTBOX_LEGACY_KEY); } catch { return; }
    if (raw === null) return;
    // Qualquer anomalia (JSON quebrado, tipo errado) vira pacote lacrado com o
    // conteudo original — preservar sempre, nunca enviar, nunca apagar sem copia.
    let entry: unknown[];
    try {
        const parsed = JSON.parse(raw);
        entry = Array.isArray(parsed) ? parsed : [{ malformed: true, raw }];
    } catch { entry = [{ malformed: true, raw }]; }
    try {
        const keptRaw = localStorage.getItem(OUTBOX_QUARANTINE_KEY) || '[]';
        let kept: unknown[];
        try { const k = JSON.parse(keptRaw); kept = Array.isArray(k) ? k : [{ malformed: true, raw: keptRaw }]; }
        catch { kept = [{ malformed: true, raw: keptRaw }]; }
        const seen = new Set(kept.map(e => JSON.stringify(e)));
        const novos = entry.filter(e => !seen.has(JSON.stringify(e)));
        if (novos.length) localStorage.setItem(OUTBOX_QUARANTINE_KEY, JSON.stringify([...kept, ...novos]));
        else if (!localStorage.getItem(OUTBOX_QUARANTINE_KEY)) localStorage.setItem(OUTBOX_QUARANTINE_KEY, '[]');
        localStorage.removeItem(OUTBOX_LEGACY_KEY); // so depois da copia gravada
    } catch { /* sem espaco/acesso: a legada fica onde esta, ainda bloqueada */ }
}

function readOutbox(): SyncOp[] { if (!syncUser) return []; try { return JSON.parse(localStorage.getItem(outboxKey()) || '[]'); } catch { return []; } }
// op_id: identidade estavel da intencao (dedupe no servidor). Gerado na
// criacao da op e NUNCA muda — retry de resposta perdida reenvia o MESMO
// op_id e o servidor devolve o resultado gravado sem reaplicar.
const novoOpId = (): string => { try { return crypto.randomUUID(); } catch { return 'op' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } };
function writeOutbox(ops: SyncOp[]): boolean {
    // Retorna se a fila foi gravada INTEIRA (uma unica escrita atomica). Na
    // falha (quota) NADA muda — o chamador decide o destino das ops em vez de
    // assumir sucesso.
    if (!syncUser) return true;
    try { localStorage.setItem(outboxKey(), JSON.stringify(ops)); return true; } catch { return false; }
}
// QUALQUER op pendente na outbox (retentavel OU rejeitada) segura o commit do
// oficial: commitState sobrescreveria os chunks compartilhados, apagando o
// visual pendente e a base que a tela mostra (a perda que a spec veda).
// Conservador por decisao de revisao — rejeitadas TAMBEM seguram. LIMITACAO
// EXPLICITA ate decisao de produto: uma op permanentemente rejeitada adia o
// oficial neste aparelho; nao e silencioso porque o banner syncwarn e a
// entrada pendente seguem visiveis. A fila legada sem dono NAO participa
// (vai para quarentena lacrada, nunca alimenta readOutbox).
function filaPendente(): boolean { return readOutbox().length > 0; }
// Retry SEM timer novo (desenho da revisao): adiar em QUALQUER caminho
// invalida o lastSeq (abaixo), entao o proximo poll de 30s da aba visivel roda
// o refresh completo INDEPENDENTE de seq novo; drenar a fila tambem invalida
// (cobre ACK por replay/dedupe, em que o servidor pode nao mudar o seq).
// Aba oculta nao retenta: nao renderiza; focus/visibilitychange disparam o
// refresh na volta e o adiamento ali tambem invalida o poll. Custo extra: zero.
function readSnap(entity: string): unknown[] { try { const v = JSON.parse(localStorage.getItem(snapKey(entity)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function writeSnap(entity: string, arr: unknown[]): boolean {
    // Retorna se a snap foi gravada. Na falha o chamador NAO marca render:
    // o diff futuro regenera a intencao contra a snap antiga.
    if (!syncUser) return true;
    try { localStorage.setItem(snapKey(entity), JSON.stringify(arr)); return true; } catch { return false; }
}

// Versao do servidor por registro (base da protecao contra telas desatualizadas;
// a comparacao em si entra em etapa propria). Mapa POR ABA: memoria da aba +
// sessionStorage (cada aba tem o seu; nada cruza abas). A chave inclui a conta,
// como todo o resto do estado. O mapa so AVANCA: versao menor recebida depois
// nunca regride a guardada. Nenhuma regra de negocio usa isso ainda.
let verCache: Record<string, Record<string, number>> | null = null;
function verKey(): string { return 'mf.ver.u.' + (syncUser || '_'); }
function readVerMap(): Record<string, Record<string, number>> {
    if (verCache) return verCache;
    let v: unknown = {};
    try { v = JSON.parse(sessionStorage.getItem(verKey()) || '{}'); } catch { v = {}; }
    verCache = (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, Record<string, number>> : {};
    return verCache;
}
function writeVerMap(): void {
    if (!syncUser || !verCache) return;
    try { sessionStorage.setItem(verKey(), JSON.stringify(verCache)); } catch { /* sem acesso */ }
}
function advanceVer(entity: string, id: string, version: number): void {
    if (!entity || !id || typeof version !== 'number' || !Number.isFinite(version)) return;
    const m = readVerMap();
    const cur = m[entity]?.[id] || 0;
    if (version > cur) { (m[entity] = m[entity] || {})[id] = version; writeVerMap(); }
}
export function getServerVersion(entity: string, id: string): number | undefined {
    return readVerMap()[entity]?.[id];
}

// BASE CONGELADA NO RENDER: ao abrir o formulario de edicao (ou iniciar a acao
// sobre um item renderizado), a aba congela a versao que aquela tela viu. O
// submit usa SEMPRE a base congelada — se um hydrate trouxer versao mais nova
// durante a edicao, o servidor recusa (stale) e a tentativa vira conflito
// recuperavel. O mapa vivo nunca e consultado no submit de formulario aberto.
const frozenBases = new Map<string, { v: number | null; token: string }>(); // chave entity|id; null = id novo
const novoPinToken = (): string => { try { return crypto.randomUUID(); } catch { return 'pin' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } };
export function freezeBase(entity: string, id: string): void {
    if (!syncUser || !id) return;
    frozenBases.set(entity + '|' + id, { v: getServerVersion(entity, id) ?? null, token: novoPinToken() });
}
export function unfreezeBase(entity: string, id: string): void {
    frozenBases.delete(entity + '|' + id);
}
// Congela uma versao ESPECIFICA como base da proxima gravacao do item: usada
// pelo Reaplicar de conflito — a base e a versao oficial VISTA na apresentacao
// do conflito, nunca o mapa vivo no toque. One-shot (consumeBase consome).
export function pinBase(entity: string, id: string, version: number): void {
    if (!syncUser || !id || !Number.isFinite(version)) return;
    frozenBases.set(entity + '|' + id, { v: version, token: novoPinToken() });
}
// Caminho v2 (camada IDB): peek NAO consome e devolve o TOKEN do pin; o consume
// so apaga se o pin atual ainda for o mesmo (um form reaberto durante o await
// cria pin NOVO que o consume atrasado nao pode apagar). Sem pin: leitura do
// mapa vivo por aba (token null) e consume vazio — nada e consumido.
export function peekBasePin(entity: string, id: string): { base: number | null; token: unknown } {
    const f = frozenBases.get(entity + '|' + id);
    if (f) return { base: f.v, token: f.token };
    return { base: getServerVersion(entity, id) ?? null, token: null };
}
export function consumeBaseToken(entity: string, id: string, token: unknown): void {
    if (token === null || token === undefined) return;
    const k = entity + '|' + id;
    const cur = frozenBases.get(k);
    if (cur && cur.token === token) frozenBases.delete(k);
}
// Identidade do item no ultimo estado sincronizado (snapshot): usada para
// nomear exclusoes cuja op nao carrega conteudo. So leitura.
export function snapLookup(entity: string, id: string): unknown | null {
    const arr = readSnap(entity);
    for (const r of arr) { if (idOf(entity, r) === id) return r; }
    return null;
}
function consumeBase(entity: string, id: string): number | null {
    const k = entity + '|' + id;
    if (frozenBases.has(k)) { const f = frozenBases.get(k); frozenBases.delete(k); return f ? f.v : null; }
    return getServerVersion(entity, id) ?? null;
}

// CONFLITOS: toda op recusada como desatualizada ('stale') sai da fila e fica
// guardada aqui — a intencao MAIS RECENTE por registro (nunca pilha), com a
// versao oficial no momento da recusa. O usuario escolhe reaplicar ou
// descartar; nada sobrescreve automatico. Por conta, como o resto do estado.
export interface ConflictItem { entity: string; id: string; op: 'upsert' | 'delete'; data?: unknown; base_v: number | null; server_version: number; server_deleted?: boolean; server?: unknown; ts: number }
function conflictsKey(): string { return 'mf.conflicts.u.' + (syncUser || '_'); }
export function listConflicts(): ConflictItem[] {
    if (!syncUser) return [];
    try { const v = JSON.parse(localStorage.getItem(conflictsKey()) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
let onConflictsChanged: (() => void) | null = null;
export function setConflictsHandler(fn: (() => void) | null): void { onConflictsChanged = fn; }
function writeConflicts(list: ConflictItem[]): boolean {
    // Retorna se os conflitos foram gravados INTEIROS. Na falha NADA muda —
    // o chamador NAO descarta a tentativa original.
    if (!syncUser) return true;
    try { localStorage.setItem(conflictsKey(), JSON.stringify(list)); return true; } catch { return false; }
}
function addConflict(c: ConflictItem): boolean {
    const ok = writeConflicts([...listConflicts().filter(x => !(x.entity === c.entity && x.id === c.id)), c]);
    if (ok) onConflictsChanged?.();
    return ok;
}
export function dismissConflict(entity: string, id: string): boolean {
    const ok = writeConflicts(listConflicts().filter(x => !(x.entity === entity && x.id === id)));
    if (ok) onConflictsChanged?.();
    return ok;
}

function idOf(entity: string, rec: unknown): string {
    if (!rec || typeof rec !== 'object') return '';
    const r = rec as Record<string, unknown>;
    return String(entity === 'catrule' ? (r.key ?? '') : (r.id ?? ''));
}

// Le a colecao atual do localStorage. Lançamentos aceitam os dois formatos
// guardados: objeto simples (com id) ou fatia compacta [id, data, desc, cat, cents, tipo, recKey].
function readCollection(entity: string): unknown[] | null {
    if (!syncUser) return [];
    try {
        if (entity === 'tx') {
            // Cada fatia e uma STRING gravada via JSON.stringify (padrao do useLocalState).
            const chunk = (i: number): string => {
                const raw = localStorage.getItem(txKey(i));
                if (raw == null) return '';
                try { const v = JSON.parse(raw); return typeof v === 'string' ? v : (Array.isArray(v) ? JSON.stringify(v) : ''); }
                catch { return raw; }
            };
            let joined = '';
            for (let i = 0; i < TXS_CHUNKS; i++) joined += chunk(i);
            if (!joined) return [];
            let raw: unknown;
            // JSON invalido = gravacao fatiada em curso (fatias mistas): sinaliza
            // "nao medir" em vez de devolver vazio — um diff contra vazio
            // apagaria a snap.
            try { raw = JSON.parse(joined); } catch { return null; }
            if (!Array.isArray(raw)) return [];
            return raw.map(p => {
                if (Array.isArray(p) && p.length >= 7) return { id: p[0], date: p[1], desc: p[2], cat: p[3], cents: p[4], type: p[5] === 'r' ? 'receita' : 'despesa', recKey: p[6] ? p[6] : undefined };
                if (p && typeof p === 'object' && 'id' in p) return p;
                return null;
            }).filter(Boolean) as unknown[];
        }
        const key = Object.keys(COLLECTIONS).find(k => COLLECTIONS[k].entity === entity);
        if (!key) return [];
        const raw: unknown = JSON.parse(localStorage.getItem(colKey(key)) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch { return []; }
}

// Leitura fresca da colecao (inclui gravacoes de outras abas desde o render).
export function readFreshCollection(entity: string): unknown[] { return readCollection(entity) ?? []; } // null = gravacao fatiada em curso (sincrona): nunca visivel para chamadores

// Pre-seed da snap com a colecao fresca: o diff da escrita seguinte vira
// exatamente a intencao da aba — itens que outra aba gravou nao viram ops.
export function seedSnap(entity: string, arr: unknown[]): void { writeSnap(entity, arr); }

// Aviso vindo do useLocalState: uma chave mudou. Recalcula a diferenca da
// colecao contra o ultimo estado sincronizado e enfileira as operacoes.
export function notifyChange(key: string): boolean {
    // Retorna false quando a intencao NAO ficou gravada por completo (fila ou
    // snap sem espaco) — o chamador avisa e a proxima gravacao regenera a
    // intencao pelo diff contra a snap antiga.
    if (!syncUser) return true; // sem conta: nada e enfileirado nem medido
    // So reage a chaves DESTA conta (com sufixo): escrita em chave antiga sem
    // dono e ignorada pelo sync — legado fica inerte.
    const base = Object.keys(COLLECTIONS).find(b => colKey(b) === key);
    const entity = key.startsWith('mf.txs' + uSuf() + '.') ? 'tx' : base ? COLLECTIONS[base].entity : undefined;
    if (!entity) return true;
    const cur = readCollection(entity);
    if (cur === null) return true; // fatias mistas: a ultima fatia fecha o JSON e mede
    const snap = readSnap(entity);
    const snapMap = new Map(snap.map(r => [idOf(entity, r), JSON.stringify(r)]));
    const curIds = new Set(cur.map(r => idOf(entity, r)));
    const now = Date.now();
    const ops: SyncOp[] = [];
    for (const r of cur) {
        const id = idOf(entity, r);
        if (id && snapMap.get(id) !== JSON.stringify(r)) ops.push({ entity, id, op: 'upsert', data: r, ts: now, base_v: consumeBase(entity, id) });
    }
    // Ausencia na colecao NUNCA vira exclusao: uma visao desatualizada da aba
    // nao pode apagar o que outra aba/aparelho gravou. Delete so nasce de
    // intencao explicita (pushDelete). A snap acompanha a colecao para o diff
    // de upserts continuar correto.
    if (ops.length) {
        const fila = readOutbox();
        // Coalesce: a op nova SUBSTITUI as pendentes do mesmo item, com vinculo
        // explicito sucessor_of -> op_id da substituida. Se a substituida ja
        // foi enviada (resposta perdida), o servidor reconcilia em cadeia
        // (adotaBase pela dedupe); se nunca saiu da fila, o vinculo e inerte.
        // Linhagem: se a substituida foi ENVIADA (sent), o vinculo e ela; se
        // nunca saiu da fila, o servidor nao a conhece — herda a linhagem ja
        // comprovada (sucessor_of dela) em vez de apontar para o desconhecido.
        const linhagem = (ant: SyncOp | undefined): string | null => !ant ? null : (ant.sent ? (ant.op_id || null) : (ant.sucessor_of || null));
        // Delete pendente NAO e removido por upsert do mesmo item (ex.: outra
        // aba edita enquanto esta apaga): a cadeia inteira sobe e o servidor
        // decide (upsert sobre tombstone => stale => conflito recuperavel).
        // Substituir o delete aqui REVIVERIA o item sem o servidor saber.
        const preserva = new Set<string>();
        for (const n of ops) {
            const pend = fila.filter(o => o.entity === n.entity && o.id === n.id);
            const ant = pend.filter(o => typeof o.op_id === 'string' && o.op_id).pop();
            n.op_id = novoOpId();
            n.sucessor_of = linhagem(ant);
            if (pend.some(o => o.op === 'delete')) { preserva.add(n.entity + '|' + n.id); n.sucessor_of = ant ? (ant.op_id || null) : null; } // qualquer delete na cadeia pendente: preserva TUDO do item
        }
        const rest = fila.filter(o => !ops.some(n => n.entity === o.entity && n.id === o.id) || preserva.has(o.entity + '|' + o.id));
        const okFila = writeOutbox([...rest, ...ops]);
        // Fila NAO gravada (quota): a snap NAO avanca — o diff futuro
        // regenera a intencao — e o chamador e avisado. Nada some em silencio.
        if (!okFila) { scheduleFlush(); return false; }
    }
    const okSnap = writeSnap(entity, cur);
    if (okSnap) markRendered(); // a aba passa a renderizar a propria escrita
    scheduleFlush();
    return okSnap;
}

// Exclusao por intencao explicita do usuario (botao apagar, desfazer paga,
// reaplicar exclusao de um conflito). Substitui qualquer op pendente do mesmo
// item na fila e tira o registro da snap desta aba. A base vem do contexto
// congelado no render (form aberto) ou do mapa de versoes vistas POR ESTA ABA.
export function pushDelete(entity: string, id: string): boolean {
    if (!syncUser) return true;
    // Delete-apois-create EM CADEIA: NAO cancela a op pendente do item — a
    // fila preserva a ordem das intencoes (create/edits seguidos do delete) e
    // o delete carrega sucessor_of -> op_id da antecessora. Se a antecessora
    // ja aplicou no servidor (resposta perdida), adotaBase reconcilia; se
    // nunca chegou, a cadeia aplica na ordem no proprio lote.
    const fila = readOutbox();
    const ant = fila.filter(o => o.entity === entity && o.id === id && typeof o.op_id === 'string' && o.op_id).pop();
    const op: SyncOp = { entity, id, op: 'delete', ts: Date.now(), base_v: consumeBase(entity, id), op_id: novoOpId() };
    if (ant) op.sucessor_of = ant.op_id || null;
    const okFila = writeOutbox([...fila, op]);
    // Fila NAO gravada (quota): NADA mais muda — a colecao e a snap ficam
    // intactas e o chamador avisa. A snap/render do delete avancam no
    // notifyChange do merge pareado (intencao sempre ANTES da colecao).
    if (!okFila) { scheduleFlush(); return false; }
    scheduleFlush();
    return true;
}

let onAuthLost: ((reason?: string) => void) | null = null;
export function setAuthLostHandler(fn: (reason?: string) => void): void { onAuthLost = fn; }

// Conta divergente detectada em qualquer leitura/escrita: limpa aviso e manda
// a aba para o login com a mensagem certa. Nada e gravado nem descartado.
export function authLostConta(): void {
    onSyncWarn?.(0, '', true);
    onAuthLost?.('A conta mudou neste aparelho. Entre de novo para sincronizar.');
}

// Aviso de rejeicao: o app mostra o motivo e a fila preserva o pendente.
let onSyncWarn: ((count: number, firstError: string, allTx: boolean) => void) | null = null;
export function setSyncWarnHandler(fn: ((count: number, firstError: string, allTx: boolean) => void) | null): void { onSyncWarn = fn; }
// Aviso persistente (banner) fora do fluxo de rejeicao: falha grave de
// gravacao local (ex.: restauracao incompleta por quota).
export function avisoPersistente(msg: string): void { onSyncWarn?.(1, msg, true); }

let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { void flush(); }, 800);
}

export async function flush(): Promise<void> {
    if (flushing || !syncUser) return;
    // Identidade imutavel por operacao: se a conta trocar durante o voo (logout/
    // login em outra aba), NADA e escrito em fila nenhuma e nada e descartado.
    const userAtStart = syncUser;
    const ops = readOutbox();
    if (!ops.length) return;
    // sent-marker: marca como ENVIADAS antes do voo. Se a resposta se perder,
    // a proxima tentativa reenvia o MESMO op_id e o servidor devolve o
    // resultado gravado (dedupe) sem reaplicar — nunca uma segunda aplicacao.
    const chavesEnvio = new Set(ops.map(o => JSON.stringify([o.entity, o.id, o.ts])));
    const filaMarcada = readOutbox();
    let marcou = false;
    for (const o of filaMarcada) { if (chavesEnvio.has(JSON.stringify([o.entity, o.id, o.ts])) && !o.sent) { o.sent = true; marcou = true; } }
    // Marcador 'sent' NAO gravado (quota): NAO envia — o retry posterior grava
    // o marcador e so entao despacha, preservando a linhagem de sucessor_of.
    // Sem envio nada e descartado; a fila fica intacta para a proxima tentativa.
    if (marcou && !writeOutbox(filaMarcada)) return;
    flushing = true;
    try {
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device: deviceLabel(), username: userAtStart, ops }),
            credentials: 'same-origin',
        });
        if (res.status === 401) { onAuthLost?.(); return; }
        if (res.status === 409) {
            let code = '';
            try { code = String((await res.json())?.code || ''); } catch { /* sem corpo */ }
            if (syncUser !== userAtStart) return; // conta trocou durante o voo: nao toca em nada
            if (code === 'legacy_queue') {
                // Fila escrita pelo app ANTIGO (ops sem base_v): a conta NAO
                // trocou — nada de derrubar para o login. Cada intencao vira
                // conflito recuperavel com base desconhecida: a versao oficial
                // entra pelo hydrate abaixo e Reaplicar/Descartar e SEMPRE
                // escolha do usuario (nunca base inventada, nunca descarte).
                // So sai da fila a op cujo registro de conflito FOI gravado;
                // sem espaco, a op fica (reenvio futuro e deduplicado pelo
                // servidor) — nenhuma tentativa some sem registro confirmado.
                const restos: SyncOp[] = [];
                for (const o of ops) { if (!addConflict({ entity: o.entity, id: o.id, op: o.op, data: o.data, base_v: null, server_version: -1, ts: Date.now() })) restos.push(o); }
                if (restos.length) onSyncWarn?.(restos.length, 'sem espaco no aparelho para registrar a recusa', true);
                writeOutbox(restos);
                // Formulario em foco: NAO recarrega — o texto nao salvo e
                // preservado e nada avança alem do que a tela renderiza. O
                // poll rearmado aplica o oficial assim que o campo desfocar.
                if (formEmUso()) { lastSeq = -1; return; }
                if (await hydrate()) window.location.reload();
                return;
            }
            authLostConta(); return; // conta trocou no aparelho: fila da dona fica intacta, aba sai para o login
        }
        if (!res.ok) return; // erro do servidor: fila fica para a proxima tentativa
        if (syncUser !== userAtStart) return; // conta trocou durante o voo: nao toca em nada
        const body = await res.json();
        const results = ((body.results || []) as { entity?: string; id: string; ts?: number; status: string; error?: string; version?: number; deleted?: boolean; server?: unknown; op_id?: string }[]);
        for (const r of results) { if (r.status === 'applied' && r.entity && typeof r.version === 'number') advanceVer(r.entity, r.id, r.version); }
        const keyOf = (o: SyncOp) => JSON.stringify([o.entity, o.id, o.ts]);
        // Correlacao inequivocavel: tripla entity+id+ts. Sem tripla (servidor
        // antigo), so casa quando ha UMA op e UM resultado para a chave — em
        // qualquer ambiguidade a op fica na fila (conservador: nunca descarta errado).
        const byTriple = new Map(results.filter(r => r.entity !== undefined && r.ts !== undefined).map(r => [JSON.stringify([r.entity, r.id, r.ts]), r]));
        // Correlacao PRIMEIRO por op_id (identidade inequivoca, inclusive no
        // replay de dedupe): a tripla entity+id+ts permanece como caminho de
        // fila legada (ops sem op_id, ex. escritas por build anterior).
        const byOpId = new Map(results.filter(r => typeof r.op_id === 'string' && r.op_id).map(r => [r.op_id as string, r]));
        const match = (o: SyncOp): typeof results => {
            if (o.op_id) { const porId = byOpId.get(o.op_id); if (porId) return [porId]; }
            const exact = byTriple.get(keyOf(o));
            if (exact) return [exact];
            const cand = results.filter(r => r.id === o.id && (r.entity === undefined || r.entity === o.entity));
            const opsMesmaChave = ops.filter(x => x.id === o.id && x.entity === o.entity);
            if (cand.length === 1 && opsMesmaChave.length === 1) return [cand[0]];
            return cand;
        };
        // So sai da fila o que o servidor aceitou (applied) ou ja tinha em versao
        // mais nova (skipped) em TODOS os resultados daquela op. Qualquer
        // rejeitada/invalida SEGURA a op na fila: nada de descarte silencioso.
        // 'stale': grava a tentativa recusada ANTES de tirar a op da fila —
        // o drop so acontece com conflito confirmado gravado. Sem espaco para
        // o registro, a op FICA na fila (reenvio futuro usa a dedupe do
        // servidor) — nenhuma tentativa some sem registro.
        // NADA de advanceVer aqui: a versao oficial so avança no mapa JUNTO
        // com o commit visual (hydrate/commitState). Promover o mapa antes do
        // render deixaria freezeBase ler base que a tela nunca mostrou — CAS
        // aceitaria conteudo velho como novo. A versao oficial vai CONGELADA
        // no conflito (server_version) e o save seguinte sai com a base velha
        // -> stale -> conflito.
        const staleGravado = new Set<string>();
        let semEspacoConflito = 0;
        for (const o of ops) {
            for (const r of match(o)) {
                if (r.status !== 'stale' || !r.entity) continue;
                const gravado = addConflict({ entity: r.entity, id: r.id, op: o.op, data: o.data, base_v: o.base_v ?? null, server_version: typeof r.version === 'number' ? r.version : 0, server_deleted: r.deleted === true, server: r.server, ts: Date.now() });
                if (gravado) staleGravado.add(keyOf(o)); else semEspacoConflito++;
            }
        }
        const drop = new Set(ops.filter(o => { const rs = match(o); return rs.length > 0 && rs.every(r => r.status === 'applied' || r.status === 'skipped' || (r.status === 'stale' && staleGravado.has(keyOf(o)))); }).map(keyOf));
        const restantes = readOutbox().filter(o => !drop.has(keyOf(o)));
        writeOutbox(restantes);
        if (restantes.length === 0 && ops.length > 0) lastSeq = -1; // fila drenou: proximo poll puxa o oficial mesmo sem seq novo (ACK replay/dedupe)
        // (A gravacao dos conflitos 'stale' aconteceu ANTES do drop acima —
        // ver staleGravado: so sai da fila o que foi registrado com sucesso.)
        const keptBad = ops.filter(o => match(o).some(r => r.status === 'rejected' || r.status === 'invalid'));
        if (keptBad.length) onSyncWarn?.(keptBad.length, String(match(keptBad[0]).find(r => r.error)?.error || ''), keptBad.every(o => o.entity === 'tx'));
        else if (semEspacoConflito) onSyncWarn?.(semEspacoConflito, 'sem espaco no aparelho para registrar a recusa', true);
        else onSyncWarn?.(0, '', true);
        if (results.some(r => r.status === 'skipped' || r.status === 'stale')) {
            // Versao oficial mais nova no servidor (skip LWW legado ou recusa CAS):
            // puxa o estado oficial e recarrega para exibi-lo. A tentativa
            // recusada ja esta guardada nos conflitos.
            // Formulario em foco: adia a aplicacao visual (texto nao salvo e
            // preservado); o poll rearmado aplica quando o campo desfocar.
            if (formEmUso()) { lastSeq = -1; return; }
            if (await hydrate()) window.location.reload();
        }
    } catch { /* erro/abort: fila preservada para a proxima tentativa */ }
    finally { flushing = false; }
}

// Estado oficial em DUAS fases: busca pura + commit. O commit (colecoes +
// snapshots + mapa de versoes) so acontece JUNTO com uma renderizacao — a
// base anexada a qualquer op e sempre a versao que a tela REALMENTE mostrou.
interface OfficialState { recs: Record<string, unknown>; vers: Record<string, Record<string, number>> }
async function fetchState(): Promise<OfficialState> {
    // Sem identidade registrada NADA persiste (evita gravar na chave curinga .u._).
    // A conta e capturada no inicio: se trocar no meio do voo, nada e escrito.
    const userAtStart = syncUser;
    if (!userAtStart) throw new Error('sem conta');
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (res.status === 401) throw new Error('auth');
    if (!res.ok) throw new Error('state');
    const body = await res.json();
    // guarda de leitura: se a resposta e de OUTRA conta (cookie trocou em outra
    // aba no meio do voo), nada e escrito — esta aba sai para o login.
    if (body.username && String(body.username).trim().toLowerCase() !== userAtStart) { authLostConta(); throw new Error('conta trocada'); }
    if (syncUser !== userAtStart) throw new Error('conta trocada'); // trocou durante o voo: nao escreve
    return { recs: body.records || {}, vers: (body.versions || {}) as Record<string, Record<string, number>> };
}
function commitState(recs: Record<string, unknown>, vers: Record<string, Record<string, number>>): boolean {
    // Commit com reversao: captura os valores atuais ANTES de escrever; se
    // QUALQUER fatia/colecao falhar (quota), restaura tudo e retorna false —
    // snap, mapa de versoes e render NAO avancam (chamador adia e o poll
    // retenta). Coleção/snap/render so avancam JUNTOS, nunca oficial pela metade.
    const antigos: [string, string | null][] = [];
    const chaves: string[] = [];
    for (let i = 0; i < TXS_CHUNKS; i++) chaves.push(txKey(i));
    for (const key of Object.keys(COLLECTIONS)) chaves.push(colKey(key));
    for (const e of ['tx', 'cat', 'rec', 'catrule']) chaves.push(snapKey(e));
    for (const k of chaves) { try { antigos.push([k, localStorage.getItem(k)]); } catch { antigos.push([k, null]); } }
    let falhouRestaura = false;
    const restaura = (): void => { for (const [k, v] of antigos) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { falhouRestaura = true; } } };
    let ok = true;
    const txs = Array.isArray(recs.tx) ? recs.tx : [];
    const s = JSON.stringify(txs);
    for (let i = 0; i < TXS_CHUNKS; i++) {
        try { localStorage.setItem(txKey(i), JSON.stringify(s.slice(i * CHUNK_CAP, (i + 1) * CHUNK_CAP))); } catch { ok = false; }
    }
    for (const [key, cfg] of Object.entries(COLLECTIONS)) {
        const arr = Array.isArray(recs[cfg.entity]) ? recs[cfg.entity] : [];
        try { localStorage.setItem(colKey(key), JSON.stringify(arr)); } catch { ok = false; }
    }
    if (ok) for (const e of ['tx', 'cat', 'rec', 'catrule']) { if (!writeSnap(e, Array.isArray(recs[e]) ? recs[e] : [])) ok = false; }
    if (!ok) { restaura(); if (falhouRestaura) avisoPersistente('falha ao restaurar o estado anterior — exporte um backup'); return false; }
    // Mapa de versoes avanca POR ULTIMO: so depois de colecao+snap gravados.
    for (const e of Object.keys(vers)) { const m = vers[e]; if (m && typeof m === 'object') for (const id of Object.keys(m)) advanceVer(e, id, Number(m[id])); }
    return true;
}

// Puxa o estado oficial da VM para o aparelho e depois empurra a fila local.
// Usada em caminhos que renderizam em seguida (abertura do app, recarregar
// apos conflito) — commit + render permanecem atomicos.
export async function hydrate(): Promise<boolean> {
    // Pendencia na fila: ADIA o commit — a aba renderiza o localStorage
    // otimista intacto (visual pendente e base vista preservados juntos).
    // Ordem inalterada: o flush segue no FIM (sem reordenar boot, sem
    // reentrancia nova — flush tem guarda `flushing` na entrada).
    if (filaPendente()) { lastSeq = -1; return false; } // adiar invalida o seq: o poll retenta <30s
    const st = await fetchState();
    if (!commitState(st.recs, st.vers)) { lastSeq = -1; return false; } // commit incompleto (quota): tudo restaurado, render NAO avanca; o poll retenta
    markRendered(); // boot/recarga: a aba renderiza o estado oficial
    await flush();
    return true;
}

// Auto-refresh Fase 1: ao voltar para o app/aba, empurra a fila local e puxa o
// estado oficial. Se o servidor tinha algo que o aparelho nao tinha, recarrega
// para renderizar os dados novos (mesmo padrao do conflito em flush()).
function snapshotData(): string {
    let s = '';
    for (let i = 0; i < TXS_CHUNKS; i++) s += localStorage.getItem(txKey(i)) || '';
    for (const k of Object.keys(COLLECTIONS)) s += '|' + (localStorage.getItem(colKey(k)) || '');
    return s;
}

// RENDER DESTA ABA: localStorage e COMPARTILHADO entre abas da mesma conta,
// entao o diff "storage antes/depois" NAO mede o que esta aba mostra — outra
// aba pode ter gravado o mesmo conteudo antes. O que manda e o que ESTA aba
// renderiza: inicializado no boot, atualizado a cada escrita propria e a cada
// commit seguido de render. Comparacao do refresh e SEMPRE contra este marcador.
let renderedSnap: string | null = null;
function markRendered(): void { try { renderedSnap = snapshotData(); } catch { /* sem acesso */ } }

function formEmUso(): boolean {
    const el = document.activeElement;
    if (el) { const tag = el.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true; }
    // Folha/modal ABERTO (form de lancamento, conflito, restore, menu): o
    // rascunho/estado vive so em React, sem persistencia — um reload aqui o
    // descartaria em silencio (mesma familia de perda que a spec veda). Adiar
    // usa o mecanismo existente: nada avanca e o proximo ciclo tenta de novo.
    try { if (document.querySelector('.overlay')) return true; } catch { /* sem acesso */ }
    return false;
}

let refreshing = false;
// Retorna false quando ADIOU o commit por causa de formulario em foco: nesse
// caso NADA avança (nem mapa, nem snap, nem colecoes) — a aba segue renderizando
// exatamente a versao que o mapa registra. Um save nesse estado vai com a base
// velha e o servidor recusa (stale → conflito), nunca aceita regressao.
export async function refreshFromServer(): Promise<boolean> {
    if (refreshing) return true;
    refreshing = true;
    try {
        await flush(); // empurra primeiro: protege o que ainda nao subiu
        // Fila com QUALQUER pendencia (ex.: POST bloqueado, GET passando):
        // ADIA o commit — commitar aqui estomparia o visual pendente das
        // outras abas via storage compartilhado e forcaria reload nelas.
        if (filaPendente()) { lastSeq = -1; return false; } // adiar invalida o seq: o poll retenta <30s
        const st = await fetchState();
        if (formEmUso()) { lastSeq = -1; return false; } // commit adiado: seq invalidado em QUALQUER chamador (poll/listener/foco), o poll retenta <30s
        if (!commitState(st.recs, st.vers)) { lastSeq = -1; return false; } // commit incompleto (quota): restaurado; o poll retenta
        const oficial = snapshotData();
        if (renderedSnap === null || oficial !== renderedSnap) { markRendered(); window.location.reload(); }
        return true;
    } catch (e) {
        const m = String(e && (e as Error).message || e);
        // 401 do GET propaga na hora: a sessao morreu e a aba cai para o
        // login SEM esperar o proximo poll (<30s). Nao e retry de rede.
        if (m === 'auth') { onAuthLost?.(); return false; }
        // 'conta trocada' ja derrubou a aba (authLostConta no fetchState).
        if (m === 'conta trocada') return true;
        // Falha de rede/GET: invalida o seq e reporta adiado — o proximo poll
        // (<30s, aba visivel) ou foco/visibilidade retenta SEM seq novo.
        lastSeq = -1; return false;
    }
    finally { refreshing = false; } // destrava SEMPRE, inclusive nos retornos acima
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
        // identidade em TODA leitura: mesmo com seq igual, conta divergente derruba a aba
        if (body.username && String(body.username).trim().toLowerCase() !== syncUser) { authLostConta(); return; }
        const seq = Number(body?.entries?.[0]?.seq) || 0;
        if (lastSeq === null) { lastSeq = seq; return; } // a abertura ja hidratou o estado
        if (seq !== lastSeq) {
            lastSeq = seq;
            const ok = await refreshFromServer();
            if (!ok) lastSeq = -1; // adiado por formulario em uso: a proxima pergunta tenta de novo
        }
    } catch { /* offline ou erro: proxima pergunta em 30s */ }
}

export function startSyncLoop(): void {
    window.addEventListener('online', () => void flush());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshFromServer(); });
    window.addEventListener('focus', () => void refreshFromServer());
    // Mitigacao 4c: o evento storage dispara SOMENTE nas OUTRAS abas — toda
    // notificacao aqui e gravacao de outra aba da mesma conta. Se outra aba
    // gravou colecoes/snap, esta aba pode estar renderizando versao velha com
    // mapa velho. Reage com o mesmo ciclo seguro de sempre (refreshFromServer
    // empurra a outbox antes, puxa o oficial e adia o commit se ha form em
    // foco). O refresh PODE recarregar a aba quando o oficial diverge do
    // render desta aba (renderedSnap) — o que nunca acontece e reload por
    // diff de storage em si. Um commit toca varias chaves seguidas:
    // coalesce de 400ms = uma refrescada por rajada.
    let storageTimer: number | null = null;
    window.addEventListener('storage', (ev) => {
        if (!ev.key || !syncUser) return;
        const k = ev.key;
        // Dono por casamento EXATO de chave (o esquema e 'mf.txs.u.<user>.<i>',
        // '<colecao>.u.<user>', 'mf.sync.snap.u.<user>.<entity>'): includes()
        // aceitaria prefixo de usuario ('jo' casaria '.u.joana') — conta errada
        // dispararia refresh cruzado.
        // Dono por PARSE exato da chave, nunca prefixo: usuario com '.' ('ab'
        // vs 'ab.c') colidiria em startsWith. tx: 'mf.txs.u.<user>.<chunk
        // numerico>'; snap: 'mf.sync.snap.u.<user>.<entidade conhecida>';
        // colecoes: '<base>.u.<user>' (termina com o usuario).
        const cutLast = (s: string): string => { const i = s.lastIndexOf('.'); return i < 0 ? '' : s.slice(0, i); };
        const tailLast = (s: string): string => { const i = s.lastIndexOf('.'); return i < 0 ? '' : s.slice(i + 1); };
        let dono = false;
        if (k.startsWith(TXS_PREFIX)) { const rest = k.slice(TXS_PREFIX.length); dono = /^u\..+\.\d+$/.test(rest.slice(0)) && cutLast(rest) === 'u.' + syncUser; }
        else if (k.startsWith(SNAP_PREFIX)) { const rest = k.slice(SNAP_PREFIX.length); dono = cutLast(rest) === 'u.' + syncUser && ['tx', 'cat', 'rec', 'catrule', 'pref'].includes(tailLast(rest)); }
        else dono = k.endsWith('.u.' + syncUser);
        const dado = dono && (k.startsWith(TXS_PREFIX) || k.startsWith(SNAP_PREFIX) || k.startsWith('mf.cats.v1.') || k.startsWith('mf.recs.v1.') || k.startsWith('mf.catrules.v1.'));
        if (!dono || !dado) return;
        if (storageTimer !== null) window.clearTimeout(storageTimer);
        storageTimer = window.setTimeout(() => { storageTimer = null; void refreshFromServer(); }, 400);
    });
    setInterval(() => void flush(), 20000);
    setInterval(() => void pollServerSeq(), POLL_MS);
    void pollServerSeq(); // marca o seq atual como base (nunca recarrega)
}
