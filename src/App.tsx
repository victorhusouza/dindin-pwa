import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalState } from './localState';
import { decryptBackupJson, encryptBackupJson, isEncryptedBackup } from './crypto';
import './style.css';
import heroImg from './photos/hero.png';

// ---------- tipos ----------

type TxType = 'despesa' | 'receita';

interface Tx {
    id: string;
    type: TxType;
    desc: string;
    cat: string; // id da categoria
    cents: number; // valor positivo, em centavos
    date: string; // YYYY-MM-DD
    fitid?: string;
    recKey?: string; // recId:AAAA-MM quando gerada por uma conta fixa
}

interface Rec {
    id: string;
    desc: string;
    cat: string;
    cents: number;
    dueDay: number; // dia do vencimento (1-31)
}

interface Category {
    id: string;
    label: string;
    icon: string;
    color: string;
    type: TxType | 'ambos';
}

// Associacao aprendida: descricao normalizada -> categoria. Editavel pelo usuario
// em "Categorias e sugestões" (menu). at = data do lancamento que a gerou (para
// desempate por recencia e limpeza das mais antigas).
interface CatRule {
    key: string; // normTxt(desc)
    desc: string; // descricao original, para exibir
    cat: string;
    type: TxType;
    at: string; // YYYY-MM-DD
}

// ---------- constantes ----------

const DEFAULT_CATS: Category[] = [
    { id: 'alimentacao', label: 'Alimentação', icon: '🍽️', color: '#c96a3a', type: 'despesa' },
    { id: 'casa', label: 'Casa', icon: '🏠', color: '#a0795a', type: 'despesa' },
    { id: 'contas', label: 'Contas', icon: '🧾', color: '#5b6abf', type: 'despesa' },
    { id: 'educacao', label: 'Educação', icon: '📚', color: '#3aa6a0', type: 'despesa' },
    { id: 'lazer', label: 'Lazer', icon: '🎮', color: '#8a6bbf', type: 'despesa' },
    { id: 'saude', label: 'Saúde', icon: '💊', color: '#d1567f', type: 'despesa' },
    { id: 'supermercado', label: 'Supermercado', icon: '🛒', color: '#5b9e4d', type: 'despesa' },
    { id: 'transporte', label: 'Transporte', icon: '🚗', color: '#4a7fbf', type: 'despesa' },
    { id: 'vestuario', label: 'Vestuário', icon: '👕', color: '#b06ad4', type: 'despesa' },
    { id: 'viagem', label: 'Viagem', icon: '✈️', color: '#3f9fd8', type: 'despesa' },
    { id: 'outros-d', label: 'Outros', icon: '📦', color: '#8a8a8a', type: 'despesa' },
    { id: 'salario', label: 'Salário', icon: '💼', color: '#2e9e6b', type: 'receita' },
    { id: 'freelance', label: 'Freelance', icon: '💻', color: '#3f8fbf', type: 'receita' },
    { id: 'investimentos', label: 'Investimentos', icon: '📈', color: '#4cae4f', type: 'receita' },
    { id: 'presente', label: 'Presente', icon: '🎁', color: '#d4709a', type: 'receita' },
    { id: 'outros-r', label: 'Outros', icon: '➕', color: '#8a8a8a', type: 'receita' },
];

const SEED_RECS: Rec[] = []; // começa vazio: cada pessoa cadastra as suas no app

const PALETTE = ['#e8833a', '#4a7fbf', '#5b9e4d', '#8a6bbf', '#d1567f', '#e3b23c', '#3aa6a0', '#b06ad4', '#3f9fd8', '#c95f5f'];

// ---------- utilidades ----------

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (cents: number) => BRL.format(cents / 100);

function uid(): string {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function donutSlice(cx: number, cy: number, rOut: number, rIn: number, a0: number, a1: number): string {
    // Fatia de rosca entre os ângulos a0 e a1 (radianos, 0 = topo, sentido horário).
    const clamped = Math.min(a1, a0 + Math.PI * 2 - 0.0001);
    const large = clamped - a0 > Math.PI ? 1 : 0;
    const pt = (r: number, a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const [x0, y0] = pt(rOut, a0);
    const [x1, y1] = pt(rOut, clamped);
    const [x2, y2] = pt(rIn, clamped);
    const [x3, y3] = pt(rIn, a0);
    return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A' + rOut + ' ' + rOut + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' L' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' A' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + x3.toFixed(2) + ' ' + y3.toFixed(2) + ' Z';
}

function todayISO(): string {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseBRValue(s: string): number | null {
    s = s.trim().replace(/[^\d.,-]/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const v = Number(s);
    return isFinite(v) && v !== 0 ? Math.round(Math.abs(v) * 100) : null;
}

function slug(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'cat';
}

// ---------- persistência no aparelho (via viewer) ----------

const CHUNKS = 32;
const CHUNK_CAP = 50000; // localStorage do navegador: muito alem do limite de 64 KiB do viewer antigo

function packChunks(s: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < CHUNKS; i++) out.push(s.slice(i * CHUNK_CAP, (i + 1) * CHUNK_CAP));
    return out;
}

// Armazenamento compacto: [data, descricao, categoria, centavos, 'r'|'d', recKey|0].
// O formato antigo (objetos com id) ainda é lido; na próxima gravação vira compacto.
type PackedTx = [string, string, string, string, number, string, string | 0];

function packTx(t: Tx): PackedTx {
    return [t.id, t.date, t.desc, t.cat, t.cents, t.type === 'receita' ? 'r' : 'd', t.recKey ?? 0];
}

function unpackTx(p: unknown, i: number): Tx | null {
    if (Array.isArray(p) && p.length >= 7) {
        return { id: String(p[0]), date: p[1], desc: p[2], cat: p[3], cents: p[4], type: p[5] === 'r' ? 'receita' : 'despesa', recKey: p[6] ? p[6] : undefined };
    }
    if (Array.isArray(p)) {
        // formato antigo sem id: usa o id posicional
        return { id: 't' + i, date: p[0], desc: p[1], cat: p[2], cents: p[3], type: p[4] === 'r' ? 'receita' : 'despesa', recKey: p[5] ? p[5] : undefined };
    }
    if (p && typeof p === 'object' && 'id' in p) return p as Tx;
    return null;
}

// Oito chaves fixas, cada uma dentro do limite por valor.
// Resgata linhas completas de um estado misto/corrompido (gravacoes parciais).
// Cada linha compacta e autocontida: ["data","desc","cat",centavos,"r"|"d",recKey|0].
function salvageRows(joined: string): Tx[] {
    const out: Tx[] = [];
    const rowRe = /\["(\d{4}-\d{2}-\d{2})","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)",(\d+),"([rd])",("(?:[^"\\]|\\.)*"|0)\]/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(joined))) {
        try {
            const desc = JSON.parse('"' + m[2] + '"') as string;
            const cat = JSON.parse('"' + m[3] + '"') as string;
            const recRaw = m[6] === '0' ? 0 : (JSON.parse(m[6]) as string);
            out.push({ id: 's' + out.length, date: m[1], desc, cat, cents: Number(m[4]), type: m[5] === 'r' ? 'receita' : 'despesa', recKey: recRaw ? recRaw : undefined });
        } catch { /* ignora linha ilegível */ }
    }
    // Formato antigo (objetos com id), se ainda houver restos.
    const objRe = /\{"id":"[^"]*","date":"(\d{4}-\d{2}-\d{2})","desc":"((?:[^"\\]|\\.)*)","cat":"((?:[^"\\]|\\.)*)","cents":(\d+),"type":"(receita|despesa)"(?:,"recKey":"((?:[^"\\]|\\.)*)")?\}/g;
    while ((m = objRe.exec(joined))) {
        try {
            out.push({ id: 's' + out.length, date: m[1], desc: JSON.parse('"' + m[2] + '"'), cat: JSON.parse('"' + m[3] + '"'), cents: Number(m[4]), type: m[5] as 'receita' | 'despesa', recKey: m[6] ? JSON.parse('"' + m[6] + '"') : undefined });
        } catch { /* ignora */ }
    }
    // Dedupe exato e ordem por data desc.
    const seen = new Set<string>();
    return out.filter(t => {
        const k = [t.date, t.desc, t.cat, t.cents, t.type, t.recKey ?? ''].join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).sort((a, b) => b.date.localeCompare(a.date));
}

// Fatias fixas de texto no localStorage (cada uma bem abaixo do limite do navegador).
function useChunkedTxs(): [Tx[], (v: Tx[]) => boolean, { ready: boolean; message: string; failed: boolean; salvage: boolean }] {
    const h0 = useLocalState('mf.txs.0', '');
    const h1 = useLocalState('mf.txs.1', '');
    const h2 = useLocalState('mf.txs.2', '');
    const h3 = useLocalState('mf.txs.3', '');
    const h4 = useLocalState('mf.txs.4', '');
    const h5 = useLocalState('mf.txs.5', '');
    const h6 = useLocalState('mf.txs.6', '');
    const h7 = useLocalState('mf.txs.7', '');
    const h8 = useLocalState('mf.txs.8', '');
    const h9 = useLocalState('mf.txs.9', '');
    const h10 = useLocalState('mf.txs.10', '');
    const h11 = useLocalState('mf.txs.11', '');
    const h12 = useLocalState('mf.txs.12', '');
    const h13 = useLocalState('mf.txs.13', '');
    const h14 = useLocalState('mf.txs.14', '');
    const h15 = useLocalState('mf.txs.15', '');
    const h16 = useLocalState('mf.txs.16', '');
    const h17 = useLocalState('mf.txs.17', '');
    const h18 = useLocalState('mf.txs.18', '');
    const h19 = useLocalState('mf.txs.19', '');
    const h20 = useLocalState('mf.txs.20', '');
    const h21 = useLocalState('mf.txs.21', '');
    const h22 = useLocalState('mf.txs.22', '');
    const h23 = useLocalState('mf.txs.23', '');
    const h24 = useLocalState('mf.txs.24', '');
    const h25 = useLocalState('mf.txs.25', '');
    const h26 = useLocalState('mf.txs.26', '');
    const h27 = useLocalState('mf.txs.27', '');
    const h28 = useLocalState('mf.txs.28', '');
    const h29 = useLocalState('mf.txs.29', '');
    const h30 = useLocalState('mf.txs.30', '');
    const h31 = useLocalState('mf.txs.31', '');
    const hooks = [h0, h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, h11, h12, h13, h14, h15, h16, h17, h18, h19, h20, h21, h22, h23, h24, h25, h26, h27, h28, h29, h30, h31];
    const ready = hooks.every(h => h[2] && h[2].ready);
    const message = Array.from(new Set(hooks.map(h => (h[2] && h[2].message) || '').filter(Boolean))).join(' ');
    const failed = hooks.some(h => { const st = (h[2] as unknown as { status?: string }).status; return st === 'quota' || st === 'invalid'; });
    const joined = hooks.map(h => h[0] || '').join('');
    let salvage = false;
    let txs: Tx[] = [];
    if (joined) {
        try {
            const raw: unknown = JSON.parse(joined);
            if (Array.isArray(raw)) txs = raw.map((p, i) => unpackTx(p, i)).filter((t): t is Tx => t !== null);
        } catch (e) {
            // Estado misto de gravacoes parciais: resgata as linhas completas.
            txs = salvageRows(joined);
            salvage = txs.length > 0;
        }
    }
    const set = (v: Tx[]): boolean => {
        const s = JSON.stringify(v.map(packTx));
        if (s.length > CHUNKS * CHUNK_CAP) return false;
        const parts = packChunks(s);
        let ok = true;
        // Grava do fim para o começo: libera as fatias antigas grandes antes de escrever as novas, sem estourar a cota total no meio do caminho.
        for (let i = CHUNKS - 1; i >= 0; i--) { if (!hooks[i][1](parts[i])) ok = false; }
        return ok;
    };
    return [txs, set, { ready, message, failed, salvage }];
}

// ---------- leitura de XLSX (sem dependências) ----------

async function readXlsx(buf: ArrayBuffer): Promise<string[][]> {
    const dv = new DataView(buf);
    const dec = new TextDecoder();
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Arquivo XLSX inválido.');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const files = new Map<string, Uint8Array>();
    for (let n = 0; n < count; n++) {
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const commentLen = dv.getUint16(off + 32, true);
        const method = dv.getUint16(off + 10, true);
        const compSize = dv.getUint32(off + 20, true);
        const name = dec.decode(new Uint8Array(buf, off + 46, nameLen));
        const localOff = dv.getUint32(off + 42, true);
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const comp = new Uint8Array(buf.slice(dataStart, dataStart + compSize));
        let data: Uint8Array;
        if (method === 0) {
            data = comp;
        } else {
            const DS = (globalThis as any).DecompressionStream;
            if (!DS) throw new Error('Seu navegador não consegue ler XLSX. Tente exportar em CSV.');
            const stream = new Blob([comp]).stream().pipeThrough(new DS('deflate-raw'));
            data = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        files.set(name, data);
        off += 46 + nameLen + extraLen + commentLen;
    }
    const xml = (name: string) => {
        const f = files.get(name);
        return f ? new DOMParser().parseFromString(dec.decode(f), 'text/xml') : null;
    };
    // shared strings
    const shared: string[] = [];
    const ss = xml('xl/sharedStrings.xml');
    if (ss) {
        ss.querySelectorAll('si').forEach(si => {
            let t = '';
            si.querySelectorAll('t').forEach(node => { t += node.textContent || ''; });
            shared.push(t);
        });
    }
    // primeira planilha
    let sheetName = 'xl/worksheets/sheet1.xml';
    if (!files.has(sheetName)) {
        const found = Array.from(files.keys()).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
        if (!found.length) throw new Error('Planilha não encontrada no arquivo.');
        sheetName = found[0];
    }
    const sheet = xml(sheetName)!;
    const colIndex = (ref: string) => {
        let c = 0;
        for (const ch of ref.replace(/\d/g, '')) c = c * 26 + (ch.charCodeAt(0) - 64);
        return c - 1;
    };
    const rows: string[][] = [];
    sheet.querySelectorAll('row').forEach(row => {
        const cells: string[] = [];
        row.querySelectorAll('c').forEach(c => {
            const ref = c.getAttribute('r') || '';
            const idx = ref ? colIndex(ref) : cells.length;
            const t = c.getAttribute('t');
            let val = '';
            if (t === 'inlineStr') {
                const is = c.querySelector('is t');
                val = is ? (is.textContent || '') : '';
            } else {
                const v = c.querySelector('v');
                const raw = v ? (v.textContent || '') : '';
                val = t === 's' ? (shared[Number(raw)] || '') : raw;
            }
            cells[idx] = val;
        });
        for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
        rows.push(cells);
    });
    return rows;
}

// ---------- interpretação de planilhas / CSV ----------

function excelSerialToISO(n: number): string | null {
    if (n < 20000 || n > 80000) return null;
    const ms = Math.round((n - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function parseDateCell(s: string): string | null {
    s = s.trim();
    if (!s) return null;
    const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (m) {
        let y = Number(m[3]); if (y < 100) y += 2000;
        return y + '-' + String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0');
    }
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];
    const num = Number(s);
    if (isFinite(num)) return excelSerialToISO(num);
    return null;
}

interface ParsedSheet {
    txs: Omit<Tx, 'id'>[];
    catLabels: string[];
}

function interpretRows(rows: string[][], source: 'xlsx' | 'csv'): ParsedSheet {
    // achar a linha de cabeçalho
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const low = rows[i].map(c => (c || '').toLowerCase());
        if (low.some(c => c.includes('data')) && low.some(c => c.includes('valor') || c.includes('descri'))) { headerIdx = i; break; }
    }
    if (headerIdx < 0) throw new Error('Não encontrei o cabeçalho (Data, Descrição, Valor) no arquivo.');
    const header = rows[headerIdx].map(c => (c || '').toLowerCase());
    const col = (names: string[]) => header.findIndex(h => names.some(n => h.includes(n)));
    const cData = col(['data']);
    const cDesc = col(['descri', 'histórico', 'historico', 'memo', 'name']);
    const cCat = col(['categ']);
    const cVal = col(['valor', 'amount']);
    const cTipo = col(['tipo', 'type']);
    if (cData < 0 || cVal < 0) throw new Error('Não encontrei as colunas Data e Valor.');
    const txs: Omit<Tx, 'id'>[] = [];
    const catLabels: string[] = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.length) continue;
        const date = parseDateCell(r[cData] || '');
        const rawVal = (r[cVal] || '').trim();
        if (!date || !rawVal) continue;
        let cents: number | null = null;
        let negative = false;
        const num = Number(rawVal);
        if (rawVal !== '' && isFinite(num)) {
            cents = Math.round(Math.abs(num) * 100);
            negative = num < 0;
        } else {
            negative = /^\s*-/.test(rawVal) || /\(.*\)/.test(rawVal);
            cents = parseBRValue(rawVal);
        }
        if (!cents) continue;
        let type: TxType = negative ? 'despesa' : 'receita';
        if (cTipo >= 0) {
            const t = (r[cTipo] || '').toLowerCase();
            if (t.includes('desp') || t.includes('déb') || t.includes('deb') || t.includes('saíd') || t.includes('said')) type = 'despesa';
            else if (t.includes('rec') || t.includes('cré') || t.includes('cre') || t.includes('entra')) type = 'receita';
        }
        const desc = (cDesc >= 0 ? (r[cDesc] || '').trim() : '') || (type === 'despesa' ? 'Despesa' : 'Receita');
        let cat = 'outros';
        if (cCat >= 0 && (r[cCat] || '').trim()) {
            const label = (r[cCat] || '').trim();
            cat = slug(label);
            if (!catLabels.includes(label)) catLabels.push(label);
            cat = slug(label);
        }
        txs.push({ type, desc: desc.slice(0, 80), cat: 'm:' + cat, cents, date });
    }
    return { txs, catLabels };
}

// ---------- leitura de OFX ----------

function parseOfx(text: string): Omit<Tx, 'id'>[] {
    const txs: Omit<Tx, 'id'>[] = [];
    const blocks = text.split(/<STMTTRN>/i).slice(1);
    for (const b of blocks) {
        const get = (tag: string) => {
            const m = b.match(new RegExp('<' + tag + '>([^<\\r\\n]+)', 'i'));
            return m ? m[1].trim() : '';
        };
        const amt = Number(get('TRNAMT').replace(',', '.'));
        const dtp = get('DTPOSTED');
        if (!isFinite(amt) || !/^\d{8}/.test(dtp)) continue;
        const date = dtp.slice(0, 4) + '-' + dtp.slice(4, 6) + '-' + dtp.slice(6, 8);
        const desc = (get('MEMO') || get('NAME') || (amt < 0 ? 'Despesa' : 'Receita')).slice(0, 80);
        const tx: Omit<Tx, 'id'> = {
            type: amt < 0 ? 'despesa' : 'receita',
            desc,
            cat: 'outros',
            cents: Math.round(Math.abs(amt) * 100),
            date,
        };
        const fitid = get('FITID');
        if (fitid) tx.fitid = fitid;
        txs.push(tx);
    }
    return txs;
}

// ---------- componentes ----------

interface ImportPreview {
    source: string;
    txs: Tx[];
    catLabels: string[];
    skipped: number;
}

// ---- Integracao com o viewer: sheets acompanham a viewport visivel ----
// O viewer do Instinct Files estica o iframe ate a altura total do conteudo,
// entao position:fixed ancoraria o sheet no documento inteiro (e nao na tela).
// O viewer publica mensagens "modal-viewport" com {top, height} da area visivel
// e trava a rolagem do fundo quando avisamos que um modal esta aberto.
type VpInfo = { top: number; height: number };
let shellChannel: string | null = null;
let lastVp: VpInfo | null = null;
let vpListenerAttached = false;
let vpOptInSent = false;
let modalCount = 0;
const vpListeners = new Set<(v: VpInfo) => void>();

function shellPost(msg: Record<string, unknown>) {
    try {
        if (window.parent && window.parent !== window && shellChannel) {
            window.parent.postMessage({ source: 'instinct-file', channel: shellChannel, ...msg }, '*');
        }
    } catch { /* sem viewer por perto */ }
}

function attachVpListener() {
    if (vpListenerAttached) return;
    vpListenerAttached = true;
    window.addEventListener('message', (e) => {
        const d = e.data as { source?: string; channel?: string; type?: string; value?: { top?: number; height?: number } } | null;
        if (!d || typeof d !== 'object' || d.source !== 'instinct-shell') return;
        if (typeof d.channel === 'string' && /^[a-f0-9-]{36}$/.test(d.channel)) shellChannel = d.channel;
        if (d.type === 'modal-viewport' && d.value && typeof d.value.top === 'number' && typeof d.value.height === 'number') {
            lastVp = { top: Math.max(0, d.value.top), height: Math.max(1, d.value.height) };
            vpListeners.forEach(fn => fn(lastVp!));
        }
    });
}

function modalOpened() {
    modalCount += 1;
    if (modalCount === 1) shellPost({ type: 'modal', value: true });
}
function modalClosed() {
    modalCount = Math.max(0, modalCount - 1);
    if (modalCount === 0) shellPost({ type: 'modal', value: false });
}

function Overlay({ onClose, children }: { onClose?: () => void; children: React.ReactNode }) {
    const [vp, setVp] = useState<VpInfo | null>(lastVp);
    useEffect(() => {
        attachVpListener();
        const fn = (v: VpInfo) => setVp(v);
        vpListeners.add(fn);
        // Avisa o viewer que um modal abriu (trava a rolagem do fundo) e pede
        // as atualizacoes de viewport. O canal chega nas mensagens do viewer,
        // entao reenviamos ate ele estar disponivel.
        let opened = false;
        const activate = () => {
            if (!shellChannel) return false;
            if (!vpOptInSent) { vpOptInSent = true; shellPost({ type: 'modal-viewport', value: true }); }
            if (!opened) { opened = true; modalOpened(); }
            return true;
        };
        activate();
        const t = window.setInterval(() => { if (activate()) window.clearInterval(t); }, 200);
        return () => {
            vpListeners.delete(fn);
            window.clearInterval(t);
            if (opened) modalClosed();
        };
    }, []);
    const style: React.CSSProperties | undefined = vp
        ? { position: 'absolute', top: vp.top, left: 0, right: 0, height: vp.height, inset: 'auto' }
        : undefined;
    return <div className="overlay" style={style} onClick={onClose}>{children}</div>;
}

function StorageMeter({ txs, cats, recs }: { txs: Tx[]; cats: Category[]; recs: Rec[] }) {
    const kb = useMemo(() => {
        const enc = new TextEncoder();
        const txJson = JSON.stringify(txs.map(packTx));
        // O viewer guarda os valores escapados (~+20%) e cobra 64 KiB no total.
        const bytes = enc.encode(txJson).length * 1.2
            + enc.encode(JSON.stringify(cats)).length * 1.2
            + enc.encode(JSON.stringify(recs)).length * 1.2
            + 2048; // marcadores de meses e tema
        return bytes / 1024;
    }, [txs, cats, recs]);
    const pct = Math.min(100, Math.round((kb / 1600) * 100));
    return <div style={{ marginTop: 14, fontSize: 12, color: 'var(--ink2)', textAlign: 'center' }}>
        Armazenamento: ~{kb.toFixed(0)} KB de 1600 KB ({pct}%)
    </div>;
}
export function App() {
    const [txs, setTxs, txsSaved] = useChunkedTxs();
    // Chaves legadas de versoes antigas do app: o viewer nunca apaga chaves, entao
    // restos grandes continuam contando na cota de 64 KiB. Gravar null encolhe cada uma.
    const legA = useLocalState('mf.txs', null as unknown);
    const legB = useLocalState('mf.txs.v1', null as unknown);
    const legC = useLocalState('mf.txs.v2', null as unknown);
    const legD = useLocalState('mf.data', null as unknown);
    const legE = useLocalState('mf.state', null as unknown);
    const txsRef = useRef<Tx[]>([]);
    txsRef.current = txs;
    const [cats, setCats, catsSaved] = useLocalState('mf.cats.v1', [] as Category[]);
    const [recs, setRecs, recsSaved] = useLocalState('mf.recs.v1', SEED_RECS);
    const [catRules, setCatRules, rulesSaved] = useLocalState('mf.catrules.v1', [] as CatRule[]);
    const [rulesSeeded, setRulesSeeded] = useLocalState('mf.catrules.seeded.v1', '');
    const catRulesRef = useRef<CatRule[]>([]);
    catRulesRef.current = catRules;
    const [recEditing, setRecEditing] = useState<Rec | null>(null);
    const [showRecForm, setShowRecForm] = useState(false);
    const [recUndoKey, setRecUndoKey] = useState('');
    const [theme, setTheme, themeSaved] = useLocalState('mf.theme.v1', 'light' as 'light' | 'dark');
    const storeReady = !!(txsSaved && txsSaved.ready && catsSaved && catsSaved.ready && themeSaved && themeSaved.ready && recsSaved && recsSaved.ready && rulesSaved && rulesSaved.ready);
    const storeMessage = Array.from(new Set([txsSaved && txsSaved.message, catsSaved && catsSaved.message, themeSaved && themeSaved.message, recsSaved && recsSaved.message, rulesSaved && rulesSaved.message].filter(Boolean))).join(' ');
    const now = new Date();
    const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
    const [showForm, setShowForm] = useState(false);
    const [editing, setEditing] = useState<Tx | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [showCatRules, setShowCatRules] = useState(false);
    const [selCat, setSelCat] = useState<string | null>(null);
    const [showInstall, setShowInstall] = useState(false);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [restore, setRestore] = useState<{ txs: Tx[]; cats: Category[]; rules?: CatRule[] } | null>(null);
    const [exportMessage, setExportMessage] = useState('');
    const [exportData, setExportData] = useState<{ url: string; json: string; file: File | null; canShare: boolean; encrypted: boolean; filename: string } | null>(null);
    const [showExportChoice, setShowExportChoice] = useState(false);
    const [showExportPw, setShowExportPw] = useState(false);
    const [exportPwBusy, setExportPwBusy] = useState(false);
    const [exportPwErr, setExportPwErr] = useState('');
    const [encRestore, setEncRestore] = useState<{ text: string } | null>(null);
    const [decBusy, setDecBusy] = useState(false);
    const [decErr, setDecErr] = useState('');
    const exportTaRef = useRef<HTMLTextAreaElement | null>(null);
    const [notice, setNotice] = useState('');
    const importInput = useRef<HTMLInputElement>(null);
    const restoreInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        document.body.style.backgroundColor = theme === 'dark' ? '#171315' : '';
        return () => { document.body.style.backgroundColor = ''; };
    }, [theme]);

    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(''), 4000);
        return () => clearTimeout(t);
    }, [notice]);

    const allCats = useMemo(() => [...DEFAULT_CATS, ...cats], [cats]);
    const catById = (id: string): Category => {
        const found = allCats.find(c => c.id === id);
        if (found) return found;
        const raw = id.startsWith('m:') ? id.slice(2) : id;
        const label = raw.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());
        return { id, label: label || 'Outros', icon: '🏷️', color: '#8a8a8a', type: 'ambos' };
    };

    const monthTxs = useMemo(() =>
        txs.filter(t => {
            const d = new Date(t.date + 'T12:00:00');
            return d.getFullYear() === month.y && d.getMonth() === month.m;
        }).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
        [txs, month]);

    const totals = useMemo(() => {
        let rec = 0, desp = 0;
        for (const t of monthTxs) { if (t.type === 'receita') rec += t.cents; else desp += t.cents; }
        return { rec, desp, saldo: rec - desp };
    }, [monthTxs]);

    const catTotals = useMemo(() => {
        const map = new Map<string, number>();
        for (const t of monthTxs) if (t.type === 'despesa') map.set(t.cat, (map.get(t.cat) || 0) + t.cents);
        return Array.from(map.entries()).map(([cat, cents]) => ({ cat, cents })).sort((a, b) => b.cents - a.cents).slice(0, 8);
    }, [monthTxs]);

    const last6 = useMemo(() => {
        const out: { label: string; rec: number; desp: number }[] = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(month.y, month.m - i, 1);
            let rec = 0, desp = 0;
            for (const t of txs) {
                const td = new Date(t.date + 'T12:00:00');
                if (td.getFullYear() === d.getFullYear() && td.getMonth() === d.getMonth()) {
                    if (t.type === 'receita') rec += t.cents; else desp += t.cents;
                }
            }
            out.push({ label: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''), rec, desp });
        }
        return out;
    }, [txs, month]);

    const grouped = useMemo(() => {
        const g = new Map<string, Tx[]>();
        for (const t of monthTxs) {
            const arr = g.get(t.date) || [];
            arr.push(t);
            g.set(t.date, arr);
        }
        return Array.from(g.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    }, [monthTxs]);

    const monthLabel = new Date(month.y, month.m, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const shiftMonth = (delta: number) => {
        const d = new Date(month.y, month.m + delta, 1);
        setMonth({ y: d.getFullYear(), m: d.getMonth() });
    };

    const persistTxs = (next: Tx[]): boolean => {
        const ok = setTxs(next);
        if (!ok) setNotice('Limite de armazenamento atingido. Exporte um backup para não perder dados.');
        return ok;
    };

    const persistTxsRef = useRef(persistTxs);
    persistTxsRef.current = persistTxs;

    // Gravacao assincrona falhou (quota/invalid): libera chaves legadas e tenta de novo.
    const reclaimedRef = useRef(false);
    useEffect(() => {
        if (!txsSaved.failed || reclaimedRef.current) return;
        reclaimedRef.current = true;
        for (const [val, setLeg] of [legA, legB, legC, legD, legE]) {
            if (val !== null && val !== undefined) setLeg(null);
        }
        const t = setTimeout(() => persistTxsRef.current(txsRef.current), 1500);
        return () => clearTimeout(t);
    }, [txsSaved.failed]);

    // Aviso só se continuar falhando depois da limpeza.
    useEffect(() => {
        if (!txsSaved.failed || !reclaimedRef.current) return;
        const t = setTimeout(() => {
            if (txsSaved.failed) setNotice('Limite de armazenamento atingido. Exporte um backup para não perder dados.');
        }, 4000);
        return () => clearTimeout(t);
    }, [txsSaved.failed]);

    // Regrava o estado resgatado de gravacoes corrompidas (linhas recuperadas, limpo e compacto).
    const salvageRef = useRef(false);
    useEffect(() => {
        if (!txsSaved.ready || !txsSaved.salvage || salvageRef.current) return;
        salvageRef.current = true;
        persistTxsRef.current(txsRef.current);
    }, [txsSaved.ready, txsSaved.salvage]);

    // Remove duplicatas exatas acumuladas (mantém a mais recente), uma vez por abertura.
    const dedupedRef = useRef(false);
    useEffect(() => {
        if (!txsSaved.ready || dedupedRef.current || txsRef.current.length === 0) return;
        dedupedRef.current = true;
        const seen = new Set<string>();
        let changed = false;
        const out = txsRef.current.filter(t => {
            const k = [t.date, t.desc, t.cat, t.cents, t.type, t.recKey ?? ''].join('|');
            if (seen.has(k)) { changed = true; return false; }
            seen.add(k);
            return true;
        });
        if (changed) persistTxsRef.current(out);
    }, [txsSaved.ready]);

    const saveTx = (tx: Tx) => {
        const exists = txs.some(t => t.id === tx.id);
        if (!persistTxs(exists ? txs.map(t => (t.id === tx.id ? tx : t)) : [tx, ...txs])) return;
        learnFromTxs([tx]);
        setShowForm(false);
        setEditing(null);
    };

    const deleteTx = (id: string) => {
        persistTxs(txs.filter(t => t.id !== id));
        setShowForm(false);
        setEditing(null);
        setNotice('Lançamento excluído.');
    };

    const monthKey = month.y + '-' + String(month.m + 1).padStart(2, '0');

    const payRec = (r: Rec) => {
        const key = r.id + ':' + monthKey;
        if (txs.some(t => t.recKey === key)) return;
        const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
        const day = Math.min(r.dueDay, daysInMonth);
        const date = monthKey + '-' + String(day).padStart(2, '0');
        const paidTx: Tx = { id: uid(), type: 'despesa', desc: r.desc, cat: r.cat, cents: r.cents, date, recKey: key };
        if (!persistTxs([paidTx, ...txs])) return;
        learnFromTxs([paidTx]);
        setNotice(r.desc + ' marcada como paga.');
    };

    const unpayRec = (r: Rec) => {
        const key = r.id + ':' + monthKey;
        if (recUndoKey !== key) { setRecUndoKey(key); return; }
        setRecUndoKey('');
        persistTxs(txs.filter(t => t.recKey !== key));
        setNotice('Pagamento desfeito.');
    };

    const saveRec = (r: Rec) => {
        const exists = recs.some(x => x.id === r.id);
        setRecs(exists ? recs.map(x => (x.id === r.id ? r : x)) : [...recs, r]);
        setShowRecForm(false);
        setRecEditing(null);
    };

    const deleteRec = (id: string) => {
        setRecs(recs.filter(x => x.id !== id));
        setShowRecForm(false);
        setRecEditing(null);
        setNotice('Conta fixa removida. Os lançamentos já feitos continuam no histórico.');
    };

    const addCategory = (label: string, type: TxType) => {
        const id = 'c:' + slug(label);
        if (!allCats.some(c => c.id === id)) {
            setCats([...cats, { id, label, icon: '🏷️', color: PALETTE[cats.length % PALETTE.length], type }]);
        }
        return id;
    };

    // Aprendizado de categorias: toda gravacao de lancamento vira/atualiza uma
    // associacao descricao -> categoria. O usuario consulta e edita em
    // "Categorias e sugestões". Mantem no maximo 400, descartando as mais antigas.
    const learnFromTxs = (list: Tx[]) => {
        const add = new Map<string, CatRule>();
        for (const t of list) {
            const key = normTxt(t.desc);
            if (key.length < 3) continue;
            add.set(t.type + '|' + key, { key, desc: t.desc.trim(), cat: t.cat, type: t.type, at: t.date });
        }
        if (!add.size) return;
        const merged = catRulesRef.current.filter(r => !add.has(r.type + '|' + r.key));
        const next = [...add.values(), ...merged].sort((a, b) => b.at.localeCompare(a.at));
        setCatRules(next.slice(0, 400));
    };

    // Semeia as associacoes a partir do historico existente (uma vez por aparelho).
    useEffect(() => {
        if (!storeReady || rulesSeeded !== '') return;
        const byKey = new Map<string, CatRule>();
        for (const t of txs) {
            const key = normTxt(t.desc);
            if (key.length < 3) continue;
            const k = t.type + '|' + key;
            const prev = byKey.get(k);
            if (!prev || t.date >= prev.at) byKey.set(k, { key, desc: t.desc, cat: t.cat, type: t.type, at: t.date });
        }
        const derived = Array.from(byKey.values()).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 400);
        if (derived.length && catRulesRef.current.length === 0) setCatRules(derived);
        setRulesSeeded('done');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storeReady, rulesSeeded]);

    const saveRule = (rule: CatRule, applyPast: boolean) => {
        const affected = applyPast ? txs.filter(t => t.type === rule.type && normTxt(t.desc) === rule.key && t.cat !== rule.cat) : [];
        if (affected.length && !persistTxs(txs.map(t => affected.some(a => a.id === t.id) ? { ...t, cat: rule.cat } : t))) return;
        setCatRules(catRulesRef.current.map(r => (r.key === rule.key && r.type === rule.type) ? rule : r));
        setNotice(affected.length ? 'Sugestão e ' + affected.length + ' ' + (affected.length === 1 ? 'lançamento anterior atualizado.' : 'lançamentos anteriores atualizados.') : 'Sugestão atualizada.');
    };

    const forgetRule = (rule: CatRule) => {
        setCatRules(catRulesRef.current.filter(r => !(r.key === rule.key && r.type === rule.type)));
        setNotice('Sugestão esquecida. As palavras-chave do app ainda podem sugerir uma categoria.');
    };

    // O app roda num iframe sem permissao de download, entao o clique num link
    // de download pode ser bloqueado sem aviso. Por isso o backup abre uma
    // folha com varias saidas: compartilhar (iPhone), baixar, abrir em nova
    // aba (escapa do iframe) ou copiar o conteudo.
    const buildBackupJson = () => JSON.stringify({ app: 'minhas-financas', version: 1, exportedAt: new Date().toISOString(), txs, cats, rules: catRulesRef.current }, null, 2);

    const openExportSheet = (json: string, encrypted: boolean) => {
        const filename = encrypted ? 'minhas-financas-backup-protegido.json' : 'minhas-financas-backup.json';
        const blob = new Blob([json], { type: 'application/json' });
        let file: File | null = null;
        let canShare = false;
        try {
            file = new File([blob], filename, { type: 'application/json' });
            canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
        } catch { file = null; canShare = false; }
        if (exportData) URL.revokeObjectURL(exportData.url);
        setExportMessage('');
        setExportData({ url: URL.createObjectURL(blob), json, file, canShare, encrypted, filename });
        setMenuOpen(false);
    };

    const submitExportPw = async (pw: string) => {
        setExportPwBusy(true);
        setExportPwErr('');
        try {
            const encJson = await encryptBackupJson(buildBackupJson(), pw);
            setShowExportPw(false);
            openExportSheet(encJson, true);
        } catch {
            setExportPwErr('Seu navegador não conseguiu criptografar. Tente o backup sem senha.');
        }
        setExportPwBusy(false);
    };

    const closeExport = () => {
        if (exportData) URL.revokeObjectURL(exportData.url);
        setExportData(null);
    };

    const downloadBackup = () => {
        if (!exportData) return;
        const a = document.createElement('a');
        a.href = exportData.url;
        a.download = exportData.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setNotice('Se o download não começou, use Compartilhar ou Copiar nesta tela.');
    };

    const shareBackup = async () => {
        if (!exportData || !exportData.file) return;
        try {
            await navigator.share({ files: [exportData.file], title: 'Backup Minhas Finanças' });
            setNotice('Backup compartilhado. Guarde o arquivo no iCloud ou no Drive.');
            closeExport();
        } catch (e) {
            if (e && (e as Error).name === 'AbortError') return; // usuario cancelou a partilha
            setNotice('Não consegui compartilhar. Tente Baixar ou Copiar o backup.');
        }
    };

    const openBackupTab = () => {
        if (!exportData) return;
        const w = window.open(exportData.url, '_blank');
        setExportMessage(w ? 'Confira a nova aba e salve o arquivo. No Mac: ⌘S. No iPhone: Compartilhar > Salvar em Arquivos.' : 'A nova aba foi bloqueada. Use Copiar conteúdo abaixo.');
    };

    const copyBackup = async () => {
        if (!exportData) return;
        try {
            await navigator.clipboard.writeText(exportData.json);
            setExportMessage('Backup copiado. Cole em um arquivo de texto e salve com o nome minhas-financas-backup.json.');
        } catch {
            const ta = exportTaRef.current;
            if (ta) {
                ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
                try { if (document.execCommand('copy')) { setExportMessage('Backup copiado. Cole em um arquivo de texto e salve como minhas-financas-backup.json.'); return; } } catch { /* selecao manual abaixo */ }
            }
            setExportMessage('Texto selecionado. Copie com ⌘C no Mac ou toque em Copiar no iPhone.');
        }
    };

    const onImportFile = async (file: File) => {
        try {
            const name = file.name.toLowerCase();
            let parsed: Omit<Tx, 'id'>[] = [];
            let catLabels: string[] = [];
            if (name.endsWith('.ofx') || name.endsWith('.ofc')) {
                parsed = parseOfx(await file.text());
            } else if (name.endsWith('.xlsx')) {
                const r = interpretRows(await readXlsx(await file.arrayBuffer()), 'xlsx');
                parsed = r.txs; catLabels = r.catLabels;
            } else if (name.endsWith('.xls')) {
                throw new Error('O formato .xls antigo não é suportado. No Mobills, exporte como .xlsx ou CSV.');
            } else if (name.endsWith('.csv') || name.endsWith('.txt')) {
                const text = await file.text();
                const lines = text.split(/\r?\n/).filter(l => l.trim());
                const delim = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
                const r = interpretRows(lines.map(l => l.split(delim).map(c => c.replace(/^"|"$/g, ''))), 'csv');
                parsed = r.txs; catLabels = r.catLabels;
            } else {
                throw new Error('Formato não reconhecido. Use OFX, XLSX ou CSV.');
            }
            if (!parsed.length) throw new Error('Nenhum lançamento encontrado no arquivo.');
            const existingKeys = new Set(txs.map(t => t.date + '|' + t.desc + '|' + t.cents));
            const existingFitids = new Set(txs.map(t => t.fitid).filter(Boolean));
            const seen = new Set<string>();
            const fresh: Tx[] = [];
            let skipped = 0;
            for (const p of parsed) {
                const key = p.date + '|' + p.desc + '|' + p.cents;
                if ((p.fitid && existingFitids.has(p.fitid)) || existingKeys.has(key) || seen.has(key)) { skipped++; continue; }
                seen.add(key);
                fresh.push({ ...p, id: uid() });
            }
            if (!fresh.length) throw new Error('Todos os lançamentos do arquivo já foram importados antes.');
            setPreview({ source: file.name, txs: fresh, catLabels, skipped });
        } catch (e: any) {
            setNotice(e && e.message ? e.message : 'Não consegui ler esse arquivo.');
        }
        if (importInput.current) importInput.current.value = '';
    };

    const confirmImport = () => {
        if (!preview) return;
        const remap = new Map<string, string>();
        for (const label of preview.catLabels) {
            const def = DEFAULT_CATS.find(c => c.id === slug(label));
            if (def) remap.set('m:' + slug(label), def.id);
        }
        const mappedTxs = preview.txs.map(t => remap.has(t.cat) ? { ...t, cat: remap.get(t.cat)! } : t);
        const newCats: Category[] = [];
        for (const label of preview.catLabels) {
            const id = 'm:' + slug(label);
            if (remap.has(id)) continue;
            if (!allCats.some(c => c.id === id) && !newCats.some(c => c.id === id)) {
                newCats.push({ id, label, icon: '🏷️', color: PALETTE[(cats.length + newCats.length) % PALETTE.length], type: 'ambos' });
            }
        }
        if (!persistTxs([...txs, ...mappedTxs])) return;
        learnFromTxs(mappedTxs);
        if (newCats.length) setCats([...cats, ...newCats]);
        setMonth({ y: new Date(mappedTxs[0].date + 'T12:00:00').getFullYear(), m: new Date(mappedTxs[0].date + 'T12:00:00').getMonth() });
        setNotice(preview.txs.length + ' lançamentos importados' + (preview.skipped ? ' (' + preview.skipped + ' duplicados ignorados)' : '') + '.');
        setPreview(null);
    };

    const onRestoreFile = async (file: File) => {
        try {
            const text = await file.text();
            let parsed: any;
            try { parsed = JSON.parse(text); } catch { throw new Error('Esse arquivo não é um backup do Minhas Finanças.'); }
            if (parsed && parsed.app === 'minhas-financas' && parsed.encrypted === true) {
                if (!isEncryptedBackup(parsed)) throw new Error('Esse backup protegido está incompleto ou corrompido.');
                setDecErr('');
                setEncRestore({ text });
            } else {
                if (!parsed || parsed.app !== 'minhas-financas' || !Array.isArray(parsed.txs)) throw new Error('Esse arquivo não é um backup do Minhas Finanças.');
                setRestore({ txs: parsed.txs, cats: Array.isArray(parsed.cats) ? parsed.cats : [], rules: Array.isArray(parsed.rules) ? parsed.rules : undefined });
            }
        } catch (e: any) {
            setNotice(e && e.message ? e.message : 'Não consegui ler o backup.');
        }
        if (restoreInput.current) restoreInput.current.value = '';
    };

    const submitDecrypt = async (pw: string) => {
        if (!encRestore) return;
        setDecBusy(true);
        setDecErr('');
        try {
            const plainJson = await decryptBackupJson(encRestore.text, pw);
            const parsed = JSON.parse(plainJson);
            if (!parsed || parsed.app !== 'minhas-financas' || !Array.isArray(parsed.txs)) throw new Error('formato');
            setEncRestore(null);
            setRestore({ txs: parsed.txs, cats: Array.isArray(parsed.cats) ? parsed.cats : [], rules: Array.isArray(parsed.rules) ? parsed.rules : undefined });
        } catch (e: any) {
            if (e && e.message === 'senha') setDecErr('Senha incorreta ou arquivo adulterado. Confira a senha e tente de novo.');
            else setDecErr('Não consegui abrir este backup. O arquivo pode estar corrompido.');
        }
        setDecBusy(false);
    };

    const confirmRestore = () => {
        if (!restore) return;
        if (!persistTxs(restore.txs)) return;
        setCats(restore.cats);
        if (restore.rules) setCatRules(restore.rules);
        setRestore(null);
        setNotice('Backup restaurado.');
    };

    return <>
        <div className={'app ' + theme}>
            <header className="topbar">
                <h1>Minhas Finanças</h1>
                <div className="topbar-actions">
                    <button className="iconbtn" aria-label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                        {theme === 'dark' ? '☀️' : '🌙'}
                    </button>
                    <button className="iconbtn topbar-add" aria-label="Adicionar lançamento" onClick={() => { setEditing(null); setShowForm(true); }}>＋</button>
                    <button className="iconbtn" aria-label="Menu" onClick={() => setMenuOpen(true)}>⋯</button>
                </div>
            </header>

            {!storeReady && <div className="empty"><p>Carregando seus dados…</p></div>}
            {storeReady && <>
            <nav className="monthnav">
                <button className="iconbtn" aria-label="Mês anterior" onClick={() => shiftMonth(-1)}>‹</button>
                <span className="monthlabel">{monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)}</span>
                <button className="iconbtn" aria-label="Próximo mês" onClick={() => shiftMonth(1)}>›</button>
            </nav>

            <section className="summary">
                <div className="saldo">
                    <span className="k">Saldo do mês</span>
                    <span className={'v ' + (totals.saldo >= 0 ? 'pos' : 'neg')}>{fmt(totals.saldo)}</span>
                </div>
                <div className="pair">
                    <div className="mini">
                        <span className="k">Receitas</span>
                        <span className="v pos">{fmt(totals.rec)}</span>
                    </div>
                    <div className="mini">
                        <span className="k">Despesas</span>
                        <span className="v neg">{fmt(totals.desp)}</span>
                    </div>
                </div>
            </section>

            {catTotals.length > 0 && <section className="panel">
                <h2>Despesas por categoria</h2>
                {(() => {
                    const shown = catTotals.slice(0, 5).reduce((s, c) => s + c.cents, 0);
                    const rest = Math.max(0, totals.desp - shown);
                    // Rosca: só as 5 maiores categorias; o restante entra em "Outras".
                    const slices: { key: string; label: string; icon: string | null; color: string; cents: number }[] = catTotals.slice(0, 5).map(({ cat, cents }) => {
                        const c = catById(cat);
                        return { key: cat, label: c.label, icon: c.icon, color: c.color, cents };
                    });
                    if (rest > 0) slices.push({ key: '__outras', label: 'Outras', icon: null, color: 'var(--ink2)', cents: rest });
                    const totalAll = Math.max(1, shown + rest);
                    let angle = 0;
                    const GAP = slices.length > 1 ? 0.012 : 0;
                    return <div className="donut-wrap">
                        <svg className="donut-svg" viewBox="0 0 200 200" role="img" aria-label="Gráfico circular das despesas por categoria">
                            {slices.map(s => {
                                const span = (s.cents / totalAll) * Math.PI * 2;
                                const a0 = angle + (span > GAP * 2 ? GAP : 0);
                                const a1 = angle + span - (span > GAP * 2 ? GAP : 0);
                                angle += span;
                                return <path key={s.key} d={donutSlice(100, 100, 92, 58, a0, a1)} fill={s.color} className={selCat ? (selCat === s.key ? 'donut-sel' : 'donut-dim') : ''} onClick={() => setSelCat(selCat === s.key ? null : s.key)}><title>{s.label}: {fmt(s.cents)} ({Math.max(1, Math.round((s.cents / totalAll) * 100))}%) - toque para destacar</title></path>;
                            })}
                            <text x="100" y="96" textAnchor="middle" className="donut-center-v">{fmt(totals.desp)}</text>
                            <text x="100" y="116" textAnchor="middle" className="donut-center-k">no mês</text>
                        </svg>
                        <div className="donut-legend">
                            {slices.map(s => {
                                const pct = (s.cents / totalAll) * 100;
                                return <div className={'donut-row' + (selCat ? (selCat === s.key ? ' donut-sel' : ' donut-dim') : '')} key={s.key} onClick={() => setSelCat(selCat === s.key ? null : s.key)}>
                                    <span className="donut-dot" style={{ background: s.color }} />
                                    <span className="donut-label">{s.icon ? s.icon + ' ' : ''}{s.label}</span>
                                    <span className="donut-pct">{pct >= 1 ? Math.round(pct) + '%' : '<1%'}</span>
                                </div>;
                            })}
                        </div>
                    </div>;
                })()}
                {catTotals.map(({ cat, cents }) => {
                    const c = catById(cat);
                    const max = catTotals[0].cents;
                    const dkey = catTotals.slice(0, 5).some(t => t.cat === cat) ? cat : '__outras';
                    return <div className={'bar' + (selCat ? (selCat === dkey ? ' donut-sel' : ' donut-dim') : '')} key={cat} onClick={() => setSelCat(selCat === dkey ? null : dkey)}>
                        <span className="bar-icon">{c.icon}</span>
                        <div className="bar-main">
                            <div className="bar-top"><span className="bar-label">{c.label}</span><span className="bar-value">{fmt(cents)}</span></div>
                            <div className="bar-track"><div className="bar-fill" style={{ width: Math.max(3, (cents / max) * 100) + '%', background: c.color }} /></div>
                        </div>
                    </div>;
                })}
            </section>}

            {last6.some(m => m.rec || m.desp) && <section className="panel">
                <h2>Últimos 6 meses</h2>
                <div className="chart6">
                    {last6.map((m6, i) => {
                        const max = Math.max(...last6.map(x => Math.max(x.rec, x.desp)), 1);
                        return <div className="chart6-col" key={i}>
                            <div className="chart6-bars">
                                {m6.rec > 0 && <div className="chart6-bar rec" style={{ height: Math.max(2, (m6.rec / max) * 100) + '%' }} title={'Receitas: ' + fmt(m6.rec)} />}
                                {m6.desp > 0 && <div className="chart6-bar desp" style={{ height: Math.max(2, (m6.desp / max) * 100) + '%' }} title={'Despesas: ' + fmt(m6.desp)} />}
                            </div>
                            <span className="chart6-label">{m6.label}</span>
                        </div>;
                    })}
                </div>
                <div className="legend"><span className="dot rec" /> Receitas <span className="dot desp" /> Despesas</div>
            </section>}

            {recs.length > 0 && <section className="panel">
                <h2>Contas fixas</h2>
                {recs.map(r => {
                    const c = catById(r.cat);
                    const key = r.id + ':' + monthKey;
                    const paid = txs.some(t => t.recKey === key);
                    const undoing = recUndoKey === key;
                    return <div className="recrow" key={r.id}>
                        <button className="rec-main" onClick={() => { setRecEditing(r); setShowRecForm(true); }}>
                            <span className="tx-icon" style={{ background: c.color + '22' }}>{c.icon}</span>
                            <span className="tx-main">
                                <span className="tx-desc">{r.desc}</span>
                                <span className="tx-cat">Vence dia {r.dueDay} · {c.label}</span>
                            </span>
                            <span className="tx-val neg">{fmt(r.cents)}</span>
                        </button>
                        {paid
                            ? <button className={'paybtn paid' + (undoing ? ' confirming' : '')} onClick={() => unpayRec(r)}>{undoing ? 'Desfazer?' : 'Paga ✓'}</button>
                            : <button className="paybtn" onClick={() => payRec(r)}>Pagar</button>}
                    </div>;
                })}
                <button className="chip addrec" onClick={() => { setRecEditing(null); setShowRecForm(true); }}>＋ Nova conta fixa</button>
            </section>}

            <section className="txlist">
                {grouped.length === 0 && <div className="empty">
                    <img src={heroImg} alt="Ilustração de uma carteira com moedas e um gráfico" />
                    <p>Nenhum lançamento neste mês.<br />Toque em <strong>+</strong> para adicionar uma despesa ou receita.</p>
                </div>}
                {grouped.map(([date, txs]) => {
                    const d = new Date(date + 'T12:00:00');
                    const label = d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
                    return <div key={date}>
                        <h3 className="dayhead">{label}</h3>
                        {txs.map(t => {
                            const c = catById(t.cat);
                            return <button className="tx" key={t.id} onClick={() => { setEditing(t); setShowForm(true); }}>
                                <span className="tx-icon" style={{ background: c.color + '22' }}>{c.icon}</span>
                                <span className="tx-main">
                                    <span className="tx-desc">{t.desc}</span>
                                    <span className="tx-cat">{c.label}</span>
                                </span>
                                <span className={'tx-val ' + (t.type === 'receita' ? 'pos' : 'neg')}>{t.type === 'receita' ? '+' : '−'} {fmt(t.cents)}</span>
                            </button>;
                        })}
                    </div>;
                })}
            </section>

            <button className="fab" aria-label="Adicionar lançamento" onClick={() => { setEditing(null); setShowForm(true); }}>+</button>

            {notice !== '' && <div className="toast" role="status">{notice}</div>}

            {menuOpen && <Overlay onClose={() => setMenuOpen(false)}>
                <div className="sheet" onClick={e => e.stopPropagation()}>
                    <div className="sheethead"><h2>Opções</h2><button className="sheetx" aria-label="Fechar" onClick={() => setMenuOpen(false)}>✕</button></div>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); setShowCatRules(true); }}>🏷️ Categorias e sugestões</button>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); importInput.current && importInput.current.click(); }}>📥 Importar arquivo (Mobills, OFX, CSV)</button>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); setShowExportChoice(true); }}>☁️ Exportar backup</button>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); restoreInput.current && restoreInput.current.click(); }}>↩️ Restaurar backup</button>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); setShowInstall(true); }}>📲 Instalar na tela de início</button>
                    <StorageMeter txs={txs} cats={cats} recs={recs} />
                    <button className="sheetbtn ghost" onClick={() => setMenuOpen(false)}>Fechar</button>
                </div>
            </Overlay>}

            {showExportChoice && <Overlay onClose={() => setShowExportChoice(false)}>
                <div className="sheet" onClick={e => e.stopPropagation()}>
                    <div className="sheethead"><h2>Exportar backup</h2><button className="sheetx" aria-label="Fechar" onClick={() => setShowExportChoice(false)}>✕</button></div>
                    <p className="hint">São {txs.length} lançamentos. Como você quer guardar o arquivo?</p>
                    <button className="sheetbtn primary" onClick={() => { setShowExportChoice(false); setExportPwErr(''); setShowExportPw(true); }}>🔒 Protegido com senha (recomendado)</button>
                    <p className="hint">Criptografado (AES-256): nem quem pegar o arquivo consegue ler. A senha é sua, fica só no seu gerenciador de senhas.</p>
                    <button className="sheetbtn" onClick={() => { setShowExportChoice(false); openExportSheet(buildBackupJson(), false); }}>📄 Sem senha</button>
                    <p className="hint">Arquivo aberto: qualquer pessoa com o arquivo lê seus lançamentos.</p>
                    <button className="sheetbtn ghost" onClick={() => setShowExportChoice(false)}>Cancelar</button>
                </div>
            </Overlay>}

            {showExportPw && <ExportPasswordSheet busy={exportPwBusy} err={exportPwErr} onSubmit={pw => { void submitExportPw(pw); }} onClose={() => setShowExportPw(false)} />}

            {encRestore && <DecryptBackupSheet busy={decBusy} err={decErr} onSubmit={pw => { void submitDecrypt(pw); }} onClose={() => setEncRestore(null)} />}

            {exportData && <Overlay onClose={closeExport}>
                <div className="sheet" onClick={e => e.stopPropagation()}>
                    <div className="sheethead"><h2>Backup pronto</h2><button className="sheetx" aria-label="Fechar" onClick={closeExport}>✕</button></div>
                    <p className="hint">São {txs.length} lançamentos. Escolha como guardar o arquivo:</p>
                    {exportData.canShare && <button className="sheetbtn primary" onClick={shareBackup}>📤 Compartilhar arquivo (Drive, Arquivos…)</button>}
                    {window.parent === window && <button className="sheetbtn" onClick={downloadBackup}>⬇️ Baixar arquivo</button>}
                    <button className={'sheetbtn' + (exportData.canShare ? '' : ' primary')} onClick={openBackupTab}>📄 Abrir arquivo para salvar</button>
                    <button className="sheetbtn" onClick={copyBackup}>📋 Copiar conteúdo</button>
                    <textarea ref={exportTaRef} className="backuptext" readOnly value={exportData.json} onFocus={e => e.currentTarget.select()} aria-label="Conteúdo do backup" />
                    <p className="hint">Abra o arquivo em outra aba. No Mac, salve com ⌘S; no iPhone, use Compartilhar &gt; Salvar em Arquivos.</p>
                    <p className="hint">{exportData.encrypted ? 'Backup protegido com senha (AES-256). Sem a senha não tem como abrir: guarde-a no seu gerenciador de senhas.' : 'Este backup não tem senha: qualquer pessoa com o arquivo consegue ler.'}</p>
                    {exportMessage && <p className="hint" role="status">{exportMessage}</p>}
                    <button className="sheetbtn ghost" onClick={closeExport}>Fechar</button>
                </div>
            </Overlay>}

            {showInstall && <Overlay onClose={() => setShowInstall(false)}>
                <div className="sheet" onClick={e => e.stopPropagation()}>
                    <div className="sheethead"><h2>Instalar no iPhone</h2><button className="sheetx" aria-label="Fechar" onClick={() => setShowInstall(false)}>✕</button></div>
                    <ol className="install-steps">
                        <li>Abra este link no <strong>Safari</strong>.</li>
                        <li>Toque em <strong>Compartilhar</strong> (o quadrado com a seta).</li>
                        <li>Toque em <strong>Adicionar à Tela de Início</strong>.</li>
                    </ol>
                    <p className="hint">Seus dados ficam salvos neste aparelho, mesmo offline.</p>
                    <button className="sheetbtn ghost" onClick={() => setShowInstall(false)}>Fechar</button>
                </div>
            </Overlay>}

            {preview && <Overlay>
                <div className="sheet">
                    <div className="sheethead"><h2>Importar de {preview.source}</h2><button className="sheetx" aria-label="Fechar" onClick={() => setPreview(null)}>✕</button></div>
                    <p>{preview.txs.length} lançamentos encontrados
                        {preview.skipped > 0 ? ' · ' + preview.skipped + ' duplicados serão ignorados' : ''}.</p>
                    <div className="preview-list">
                        {preview.txs.slice(0, 5).map(t => <div className="preview-row" key={t.id}>
                            <span>{new Date(t.date + 'T12:00:00').toLocaleDateString('pt-BR')}</span>
                            <span className="preview-desc">{t.desc}</span>
                            <span className={t.type === 'receita' ? 'pos' : 'neg'}>{t.type === 'receita' ? '+' : '−'} {fmt(t.cents)}</span>
                        </div>)}
                        {preview.txs.length > 5 && <p className="hint">… e mais {preview.txs.length - 5}.</p>}
                    </div>
                    <button className="sheetbtn primary" onClick={confirmImport}>Importar {preview.txs.length} lançamentos</button>
                    <button className="sheetbtn ghost" onClick={() => setPreview(null)}>Cancelar</button>
                </div>
            </Overlay>}

            {restore && <Overlay>
                <div className="sheet">
                    <div className="sheethead"><h2>Restaurar backup</h2><button className="sheetx" aria-label="Fechar" onClick={() => setRestore(null)}>✕</button></div>
                    <p>O backup tem {restore.txs.length} lançamentos. Restaurar <strong>substitui</strong> todos os dados atuais deste aparelho.</p>
                    <button className="sheetbtn primary" onClick={confirmRestore}>Substituir e restaurar</button>
                    <button className="sheetbtn ghost" onClick={() => setRestore(null)}>Cancelar</button>
                </div>
            </Overlay>}

            {showCatRules && <CatRulesSheet
                rules={catRules}
                txs={txs}
                cats={allCats}
                onSaveRule={saveRule}
                onForget={forgetRule}
                onClose={() => setShowCatRules(false)}
            />}

            {showRecForm && <RecForm
                key={recEditing ? recEditing.id : 'nova'}
                initial={recEditing}
                cats={allCats.filter(c => c.type === 'despesa' || c.type === 'ambos')}
                onSave={saveRec}
                onDelete={recEditing ? () => deleteRec(recEditing.id) : null}
                onAddCategory={addCategory}
                onClose={() => { setShowRecForm(false); setRecEditing(null); }}
            />}

            {showForm && <TxForm
                key={editing ? editing.id : 'novo'}
                initial={editing}
                cats={allCats}
                rules={catRules}
                onSave={saveTx}
                onDelete={editing ? () => deleteTx(editing.id) : null}
                onAddCategory={addCategory}
                onClose={() => { setShowForm(false); setEditing(null); }}
            />}

            </>}
            {storeMessage !== '' && <p className="hint">{storeMessage}</p>}
            <input ref={importInput} type="file" accept=".ofx,.ofc,.xlsx,.xls,.csv,.txt" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files && e.target.files[0]; if (f) void onImportFile(f); }} />
            <input ref={restoreInput} type="file" accept=".json,application/json" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files && e.target.files[0]; if (f) void onRestoreFile(f); }} />
        </div>
    </>;
}

// ---------- senha do backup (exportar e restaurar) ----------

function ExportPasswordSheet(props: { busy: boolean; err: string; onSubmit: (pw: string) => void; onClose: () => void }) {
    const [pw1, setPw1] = useState('');
    const [pw2, setPw2] = useState('');
    const [err, setErr] = useState('');
    const submit = () => {
        if (pw1.length < 8) { setErr('Use pelo menos 8 caracteres.'); return; }
        if (pw1 !== pw2) { setErr('As senhas não são iguais.'); return; }
        setErr('');
        props.onSubmit(pw1);
    };
    return <Overlay>
        <div className="sheet form">
            <div className="sheethead"><h2>Senha do backup</h2><button className="sheetx" aria-label="Fechar" onClick={props.onClose}>✕</button></div>
            <p className="hint">O arquivo fica criptografado (AES-256). Sem a senha ninguém lê, nem você: guarde-a no seu gerenciador de senhas.</p>
            <label className="field">
                <span>Senha</span>
                <input type="password" autoComplete="new-password" value={pw1} onChange={e => setPw1(e.target.value)} autoFocus />
            </label>
            <label className="field">
                <span>Repita a senha</span>
                <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} />
            </label>
            {(err || props.err) && <p className="error">{err || props.err}</p>}
            <button className="sheetbtn primary" disabled={props.busy} onClick={submit}>{props.busy ? 'Criptografando…' : 'Criar backup protegido'}</button>
            <button className="sheetbtn ghost" onClick={props.onClose}>Cancelar</button>
        </div>
    </Overlay>;
}

function DecryptBackupSheet(props: { busy: boolean; err: string; onSubmit: (pw: string) => void; onClose: () => void }) {
    const [pw, setPw] = useState('');
    return <Overlay>
        <div className="sheet form">
            <div className="sheethead"><h2>Backup protegido</h2><button className="sheetx" aria-label="Fechar" onClick={props.onClose}>✕</button></div>
            <p className="hint">Este backup está criptografado. Digite a senha que você usou ao exportar.</p>
            <label className="field">
                <span>Senha do backup</span>
                <input type="password" autoComplete="off" value={pw} onChange={e => setPw(e.target.value)} autoFocus />
            </label>
            {props.err && <p className="error">{props.err}</p>}
            <button className="sheetbtn primary" disabled={props.busy || !pw} onClick={() => props.onSubmit(pw)}>{props.busy ? 'Descriptografando…' : 'Abrir backup'}</button>
            <button className="sheetbtn ghost" onClick={props.onClose}>Cancelar</button>
        </div>
    </Overlay>;
}

// ---------- formulário ----------

// ---------- sugestao automatica de categoria ----------
// Sugere a categoria enquanto digita a descricao: (1) historico do proprio
// usuario (descricao igual ou parecida, mais recente/frequente vence — aprende
// com as correcoes dele, pois elas viram lancamentos), (2) palavras-chave
// simples. Tudo local, sem servico externo.
function normTxt(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

const CAT_KEYWORDS: Array<[RegExp, string[]]> = [
    [/\b(uber|99|taxi|onibus|metro|gasolina|combustivel|estacionamento|pedagio|passagem)\b/, ['transporte']],
    [/\b(remedio|remedios|farmacia|medicamento|consulta|medico|dentista|exame|plano de saude)\b/, ['saude']],
    [/\b(mercado|supermercado|atacadao|feira|acougue|hortifruti)\b/, ['supermercado']],
    [/\b(ifood|lanche|hamburguer|pizza|delivery|mcdonalds|burger)\b/, ['ifood/lanche', 'restaurante']],
    [/\b(restaurante|almoco|jantar|rodizio|marmita|self.?service)\b/, ['restaurante', 'ifood/lanche']],
    [/\b(luz|energia|equatorial)\b/, ['luz']],
    [/\b(agua|saneamento|cosanpa)\b/, ['agua']],
    [/\b(internet|fibra|banda larga|wifi)\b/, ['internet']],
    [/\b(telefone|celular|recarga|tim|claro|vivo|oi)\b/, ['telefone']],
    [/\b(netflix|spotify|disney|hbo|prime video|youtube|streaming|globoplay)\b/, ['streaming']],
    [/\b(curso|escola|faculdade|mensalidade|udemy|alura)\b/, ['educacao']],
    [/\b(livro|livros|livraria|kindle)\b/, ['livros', 'educacao']],
    [/\b(aluguel|alugueis)\b/, ['aluguel', 'casa']],
    [/\b(fatura|cartao de credito)\b/, ['fatura cartao']],
    [/\b(tarifa|anuidade|manutencao de conta)\b/, ['tarifa bancaria']],
    [/\b(dizimo|oferta|igreja)\b/, ['dizimo e ofertas']],
    [/\b(emprestimo|consignado)\b/, ['emprestimo']],
    [/\b(bitcoin|btc|cripto|binance)\b/, ['bitcoin', 'investimentos']],
    [/\b(salario|pagamento|prolabore)\b/, ['salario']],
    [/\b(freelance|freela|bico)\b/, ['freelance']],
    [/\b(presente|aniversario)\b/, ['presente']],
    [/\b(investimento|aplicacao|rendimento|dividendos|cdb|tesouro)\b/, ['investimentos']],
];

function suggestCategory(desc: string, rules: CatRule[], cats: Category[], type: TxType): string | null {
    const q = normTxt(desc);
    if (q.length < 3) return null;
    const eligible = new Set(cats.filter(c => c.type === type || c.type === 'ambos').map(c => c.id));
    const byNormLabel = new Map(cats.map(c => [normTxt(c.label), c.id]));
    // aprendizado do usuario: exato (mais recente) > prefixo (mais recente)
    let exact: CatRule | null = null;
    let prefix: CatRule | null = null;
    for (const r of rules) {
        if (r.type !== type || !eligible.has(r.cat)) continue;
        if (r.key === q) { if (!exact || r.at >= exact.at) exact = r; }
        else if (r.key.startsWith(q) || (q.length >= 4 && q.startsWith(r.key) && r.key.length >= 3)) {
            if (!prefix || r.at > prefix.at) prefix = r;
        }
    }
    if (exact) return exact.cat;
    if (prefix) return prefix.cat;
    for (const [re, labels] of CAT_KEYWORDS) {
        if (re.test(q)) {
            for (const l of labels) {
                const id = byNormLabel.get(l);
                if (id && eligible.has(id)) return id;
            }
        }
    }
    return null;
}

function TxForm(props: {
    initial: Tx | null;
    cats: Category[];
    rules: CatRule[];
    onSave: (tx: Tx) => void;
    onDelete: (() => void) | null;
    onAddCategory: (label: string, type: TxType) => string;
    onClose: () => void;
}) {
    const { initial } = props;
    const [type, setType] = useState<TxType>(initial ? initial.type : 'despesa');
    const [valor, setValor] = useState(initial ? (initial.cents / 100).toFixed(2).replace('.', ',') : '');
    const [desc, setDesc] = useState(initial ? initial.desc : '');
    const [cat, setCat] = useState(initial ? initial.cat : '');
    const [date, setDate] = useState(initial ? initial.date : todayISO());
    const [novaCat, setNovaCat] = useState('');
    const [confirmDel, setConfirmDel] = useState(false);
    const [err, setErr] = useState('');

    const cats = props.cats.filter(c => c.type === type || c.type === 'ambos');
    const [catTouched, setCatTouched] = useState(!!initial);
    const suggested = useMemo(
        () => (catTouched ? null : suggestCategory(desc, props.rules, props.cats, type)),
        [desc, props.rules, props.cats, type, catTouched],
    );
    const chosenCat = cat || suggested || (type === 'despesa' ? 'outros-d' : 'outros-r');

    const submit = () => {
        const cents = parseBRValue(valor);
        if (!cents) { setErr('Informe um valor válido, por exemplo 42,90.'); return; }
        if (!date) { setErr('Informe a data.'); return; }
        props.onSave({
            id: initial ? initial.id : uid(),
            type,
            desc: desc.trim() || (type === 'despesa' ? 'Despesa' : 'Receita'),
            cat: chosenCat,
            cents,
            date,
            fitid: initial ? initial.fitid : undefined,
        });
    };

    return <Overlay>
        <div className="sheet form">
            <div className="sheethead"><h2>{initial ? 'Editar lançamento' : 'Novo lançamento'}</h2><button className="sheetx" aria-label="Fechar" onClick={props.onClose}>✕</button></div>
            <div className="typetoggle">
                <button className={type === 'despesa' ? 'active desp' : ''} onClick={() => setType('despesa')}>Despesa</button>
                <button className={type === 'receita' ? 'active rec' : ''} onClick={() => setType('receita')}>Receita</button>
            </div>
            <label className="field">
                <span>Valor</span>
                <input inputMode="decimal" placeholder="0,00" value={valor} onChange={e => setValor(e.target.value)} autoFocus={!initial} />
            </label>
            <label className="field">
                <span>Descrição</span>
                <input type="text" placeholder={type === 'despesa' ? 'Ex.: almoço' : 'Ex.: salário'} value={desc} onChange={e => setDesc(e.target.value)} />
            </label>
            <div className="field">
                <span>Categoria</span>
                <div className="catchips">
                    {cats.map(c => <button key={c.id} className={'chip' + (chosenCat === c.id ? ' sel' : '')} onClick={() => { setCat(c.id); setCatTouched(true); }}>
                        {c.icon} {c.label}
                    </button>)}
                </div>
                {!cat && suggested && <p className="hint">Categoria sugerida pela descrição — toque em outra para mudar.</p>}
                <div className="newcat">
                    <input type="text" placeholder="Nova categoria…" value={novaCat} onChange={e => setNovaCat(e.target.value)} />
                    <button className="chip" disabled={!novaCat.trim()} onClick={() => { const id = props.onAddCategory(novaCat.trim(), type); setCat(id); setCatTouched(true); setNovaCat(''); }}>Adicionar</button>
                </div>
            </div>
            <label className="field">
                <span>Data</span>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </label>
            {err && <p className="error">{err}</p>}
            <button className="sheetbtn primary" onClick={submit}>{initial ? 'Salvar alterações' : 'Adicionar'}</button>
            {props.onDelete && <button className={'sheetbtn danger'} onClick={() => { if (confirmDel) props.onDelete!(); else setConfirmDel(true); }}>
                {confirmDel ? 'Toque de novo para confirmar a exclusão' : 'Excluir lançamento'}
            </button>}
            <button className="sheetbtn ghost" onClick={props.onClose}>Cancelar</button>
        </div>
    </Overlay>;
}


// ---------- formulário de conta fixa ----------

function RecForm(props: {
    initial: Rec | null;
    cats: Category[];
    onSave: (r: Rec) => void;
    onDelete: (() => void) | null;
    onAddCategory: (label: string, type: TxType) => string;
    onClose: () => void;
}) {
    const { initial } = props;
    const [desc, setDesc] = useState(initial ? initial.desc : '');
    const [valor, setValor] = useState(initial ? (initial.cents / 100).toFixed(2).replace('.', ',') : '');
    const [cat, setCat] = useState(initial ? initial.cat : '');
    const [dia, setDia] = useState(initial ? String(initial.dueDay) : '10');
    const [novaCat, setNovaCat] = useState('');
    const [confirmDel, setConfirmDel] = useState(false);
    const [err, setErr] = useState('');

    const chosenCat = cat || 'outros-d';

    const submit = () => {
        const cents = parseBRValue(valor);
        if (!cents) { setErr('Informe um valor válido, por exemplo 99,90.'); return; }
        const dueDay = Math.round(Number(dia));
        if (!isFinite(dueDay) || dueDay < 1 || dueDay > 31) { setErr('O dia de vencimento precisa ser entre 1 e 31.'); return; }
        if (!desc.trim()) { setErr('Dê um nome para a conta fixa.'); return; }
        props.onSave({ id: initial ? initial.id : uid(), desc: desc.trim(), cat: chosenCat, cents, dueDay });
    };

    return <Overlay>
        <div className="sheet form">
            <div className="sheethead"><h2>{initial ? 'Editar conta fixa' : 'Nova conta fixa'}</h2><button className="sheetx" aria-label="Fechar" onClick={props.onClose}>✕</button></div>
            <label className="field">
                <span>Nome</span>
                <input type="text" placeholder="Ex.: Aluguel" value={desc} onChange={e => setDesc(e.target.value)} autoFocus={!initial} />
            </label>
            <label className="field">
                <span>Valor mensal</span>
                <input inputMode="decimal" placeholder="0,00" value={valor} onChange={e => setValor(e.target.value)} />
            </label>
            <label className="field">
                <span>Dia de vencimento</span>
                <input inputMode="numeric" placeholder="10" value={dia} onChange={e => setDia(e.target.value.replace(/\D/g, '').slice(0, 2))} />
            </label>
            <div className="field">
                <span>Categoria</span>
                <div className="catchips">
                    {props.cats.map(c => <button key={c.id} className={'chip' + (chosenCat === c.id ? ' sel' : '')} onClick={() => setCat(c.id)}>
                        {c.icon} {c.label}
                    </button>)}
                </div>
                <div className="newcat">
                    <input type="text" placeholder="Nova categoria…" value={novaCat} onChange={e => setNovaCat(e.target.value)} />
                    <button className="chip" disabled={!novaCat.trim()} onClick={() => { const id = props.onAddCategory(novaCat.trim(), 'despesa'); setCat(id); setNovaCat(''); }}>Adicionar</button>
                </div>
            </div>
            {err && <p className="error">{err}</p>}
            <button className="sheetbtn primary" onClick={submit}>{initial ? 'Salvar alterações' : 'Adicionar'}</button>
            {props.onDelete && <button className="sheetbtn danger" onClick={() => { if (confirmDel) props.onDelete!(); else setConfirmDel(true); }}>
                {confirmDel ? 'Toque de novo para confirmar a exclusão' : 'Remover conta fixa'}
            </button>}
            <button className="sheetbtn ghost" onClick={props.onClose}>Cancelar</button>
        </div>
    </Overlay>;
}


// ---------- categorias e sugestões aprendidas ----------

// Tela de consulta e edição do que o app aprendeu: descrição -> categoria.
// O usuário vê a lista, filtra, muda a categoria de uma descrição (com prévia
// dos lançamentos antigos que aquilo afetaria) ou esquece a sugestão.
function CatRulesSheet(props: {
    rules: CatRule[];
    txs: Tx[];
    cats: Category[];
    onSaveRule: (rule: CatRule, applyPast: boolean) => void;
    onForget: (rule: CatRule) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const [sel, setSel] = useState<CatRule | null>(null);
    const [cat, setCat] = useState('');
    const [applyPast, setApplyPast] = useState(false);
    const [confirmForget, setConfirmForget] = useState(false);

    const catOf = (id: string): Category => props.cats.find(c => c.id === id)
        || { id, label: id.replace(/^m:/, '').replace(/-/g, ' '), icon: '🏷️', color: '#8a8a8a', type: 'ambos' };

    const counts = useMemo(() => {
        const m = new Map<string, number>();
        for (const t of props.txs) {
            const k = t.type + '|' + normTxt(t.desc);
            m.set(k, (m.get(k) || 0) + 1);
        }
        return m;
    }, [props.txs]);

    const open = (r: CatRule) => { setSel(r); setCat(r.cat); setApplyPast(false); setConfirmForget(false); };

    if (sel) {
        const matches = props.txs
            .filter(t => t.type === sel.type && normTxt(t.desc) === sel.key)
            .sort((a, b) => b.date.localeCompare(a.date));
        const changed = cat !== '' && cat !== sel.cat;
        const affected = changed ? matches.filter(t => t.cat !== cat) : [];
        const catsForType = props.cats.filter(c => c.type === sel.type || c.type === 'ambos');
        const save = () => {
            if (!changed) return;
            props.onSaveRule({ ...sel, cat }, applyPast);
            setSel(null);
        };
        return <Overlay onClose={props.onClose}>
            <div className="sheet" onClick={e => e.stopPropagation()}>
                <div className="sheethead"><h2>{sel.desc}</h2><button className="sheetx" aria-label="Voltar" onClick={() => setSel(null)}>✕</button></div>
                <p className="hint">{sel.type === 'receita' ? 'Receita' : 'Despesa'} · o app sugere esta descrição como:</p>
                <div className="catchips">
                    {catsForType.map(c => <button key={c.id} className={'chip' + (cat === c.id ? ' sel' : '')} onClick={() => setCat(c.id)}>
                        {c.icon} {c.label}
                    </button>)}
                </div>
                {matches.length > 0 && <>
                    <h3 className="rules-sub">{matches.length === 1 ? '1 lançamento com essa descrição' : matches.length + ' lançamentos com essa descrição'}</h3>
                    <div className="preview-list">
                        {matches.slice(0, 5).map(t => <div className="preview-row" key={t.id}>
                            <span>{new Date(t.date + 'T12:00:00').toLocaleDateString('pt-BR')}</span>
                            <span className="preview-desc">{catOf(t.cat).label}</span>
                            <span className={t.type === 'receita' ? 'pos' : 'neg'}>{t.type === 'receita' ? '+' : '−'} {fmt(t.cents)}</span>
                        </div>)}
                        {matches.length > 5 && <p className="hint">… e mais {matches.length - 5}.</p>}
                    </div>
                </>}
                {changed && affected.length > 0 && <label className="checkrow">
                    <input type="checkbox" checked={applyPast} onChange={e => setApplyPast(e.target.checked)} />
                    <span>Atualizar também {affected.length === 1 ? 'o 1 lançamento anterior' : 'os ' + affected.length + ' lançamentos anteriores'}</span>
                </label>}
                <p className="hint">Mudar aqui vale para os próximos lançamentos{changed && affected.length > 0 ? ', a menos que você marque a opção acima' : ''}.</p>
                <button className="sheetbtn primary" disabled={!changed} onClick={save}>Salvar</button>
                <button className="sheetbtn danger" onClick={() => { if (confirmForget) { props.onForget(sel); setSel(null); } else setConfirmForget(true); }}>
                    {confirmForget ? 'Toque de novo para confirmar' : 'Esquecer esta sugestão'}
                </button>
                <button className="sheetbtn ghost" onClick={() => setSel(null)}>Voltar</button>
            </div>
        </Overlay>;
    }

    const q = normTxt(query);
    const filtered = props.rules.filter(r => !q || r.key.includes(q) || normTxt(catOf(r.cat).label).includes(q));
    const shown = filtered.slice(0, 60);
    return <Overlay onClose={props.onClose}>
        <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheethead"><h2>Categorias e sugestões</h2><button className="sheetx" aria-label="Fechar" onClick={props.onClose}>✕</button></div>
            <p className="hint">O app aprende a categoria pela descrição dos seus lançamentos. Toque numa descrição para ver, mudar ou esquecer a sugestão.</p>
            {props.rules.length > 8 && <div className="field">
                <input type="text" placeholder="Buscar descrição ou categoria…" value={query} onChange={e => setQuery(e.target.value)} />
            </div>}
            {shown.length === 0 && <p className="hint">{props.rules.length === 0
                ? 'Nenhuma sugestão aprendida ainda. O app aprende sozinho quando você salva um lançamento.'
                : 'Nada encontrado para essa busca.'}</p>}
            <div className="rules-list">
                {shown.map(r => {
                    const c = catOf(r.cat);
                    const n = counts.get(r.type + '|' + r.key) || 0;
                    return <button className="rule" key={r.type + '|' + r.key} onClick={() => open(r)}>
                        <span className="tx-icon" style={{ background: c.color + '22' }}>{c.icon}</span>
                        <span className="rule-main">
                            <span className="rule-desc">{r.desc}</span>
                            <span className="rule-cat">{r.type === 'receita' ? 'Receita · ' : ''}{c.label}{n > 0 ? ' · ' + n + (n === 1 ? ' lançamento' : ' lançamentos') : ''}</span>
                        </span>
                        <span className="rule-arrow">›</span>
                    </button>;
                })}
            </div>
            {filtered.length > shown.length && <p className="hint">… e mais {filtered.length - shown.length}. Use a busca para filtrar.</p>}
            <button className="sheetbtn ghost" onClick={props.onClose}>Fechar</button>
        </div>
    </Overlay>;
}
