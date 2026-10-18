import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalState } from './localState';
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

const CHUNKS = 8;
const CHUNK_CAP = 14000; // margem abaixo do limite de 16 KiB por valor

function packChunks(s: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < CHUNKS; i++) out.push(s.slice(i * CHUNK_CAP, (i + 1) * CHUNK_CAP));
    return out;
}

// Armazenamento compacto: [data, descricao, categoria, centavos, 'r'|'d', recKey|0].
// O formato antigo (objetos com id) ainda é lido; na próxima gravação vira compacto.
type PackedTx = [string, string, string, number, string, string | 0];

function packTx(t: Tx): PackedTx {
    return [t.date, t.desc, t.cat, t.cents, t.type === 'receita' ? 'r' : 'd', t.recKey ?? 0];
}

function unpackTx(p: unknown, i: number): Tx | null {
    if (Array.isArray(p)) {
        return { id: 't' + i, date: p[0], desc: p[1], cat: p[2], cents: p[3], type: p[4] === 'r' ? 'receita' : 'despesa', recKey: p[5] ? p[5] : undefined };
    }
    if (p && typeof p === 'object' && 'id' in p) return p as Tx;
    return null;
}

// Oito chaves fixas, cada uma dentro do limite por valor.
function useChunkedTxs(): [Tx[], (v: Tx[]) => boolean, { ready: boolean; message: string }] {
    const h0 = useLocalState('mf.txs.0', '');
    const h1 = useLocalState('mf.txs.1', '');
    const h2 = useLocalState('mf.txs.2', '');
    const h3 = useLocalState('mf.txs.3', '');
    const h4 = useLocalState('mf.txs.4', '');
    const h5 = useLocalState('mf.txs.5', '');
    const h6 = useLocalState('mf.txs.6', '');
    const h7 = useLocalState('mf.txs.7', '');
    const hooks = [h0, h1, h2, h3, h4, h5, h6, h7];
    const ready = hooks.every(h => h[2] && h[2].ready);
    const message = Array.from(new Set(hooks.map(h => (h[2] && h[2].message) || '').filter(Boolean))).join(' ');
    const joined = hooks.map(h => h[0] || '').join('');
    let txs: Tx[] = [];
    if (joined) {
        try {
            const raw: unknown = JSON.parse(joined);
            if (Array.isArray(raw)) txs = raw.map((p, i) => unpackTx(p, i)).filter((t): t is Tx => t !== null);
        } catch (e) { txs = []; }
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
    return [txs, set, { ready, message }];
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

export function App() {
    const [txs, setTxs, txsSaved] = useChunkedTxs();
    const [cats, setCats, catsSaved] = useLocalState('mf.cats.v1', [] as Category[]);
    const [recs, setRecs, recsSaved] = useLocalState('mf.recs.v1', SEED_RECS);
    const [recEditing, setRecEditing] = useState<Rec | null>(null);
    const [showRecForm, setShowRecForm] = useState(false);
    const [recUndoKey, setRecUndoKey] = useState('');
    const [theme, setTheme, themeSaved] = useLocalState('mf.theme.v1', 'light' as 'light' | 'dark');
    const storeReady = !!(txsSaved && txsSaved.ready && catsSaved && catsSaved.ready && themeSaved && themeSaved.ready && recsSaved && recsSaved.ready);
    const storeMessage = Array.from(new Set([txsSaved && txsSaved.message, catsSaved && catsSaved.message, themeSaved && themeSaved.message, recsSaved && recsSaved.message].filter(Boolean))).join(' ');
    const now = new Date();
    const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
    const [showForm, setShowForm] = useState(false);
    const [editing, setEditing] = useState<Tx | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [showInstall, setShowInstall] = useState(false);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [restore, setRestore] = useState<{ txs: Tx[]; cats: Category[] } | null>(null);
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

    const saveTx = (tx: Tx) => {
        const exists = txs.some(t => t.id === tx.id);
        if (!persistTxs(exists ? txs.map(t => (t.id === tx.id ? tx : t)) : [tx, ...txs])) return;
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
        if (!persistTxs([{ id: uid(), type: 'despesa', desc: r.desc, cat: r.cat, cents: r.cents, date, recKey: key }, ...txs])) return;
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

    const exportBackup = () => {
        const payload = { app: 'minhas-financas', version: 1, exportedAt: new Date().toISOString(), txs, cats };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'minhas-financas-backup.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setMenuOpen(false);
        setNotice('Backup gerado. Guarde o arquivo no iCloud ou no Drive.');
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
        if (newCats.length) setCats([...cats, ...newCats]);
        setMonth({ y: new Date(mappedTxs[0].date + 'T12:00:00').getFullYear(), m: new Date(mappedTxs[0].date + 'T12:00:00').getMonth() });
        setNotice(preview.txs.length + ' lançamentos importados' + (preview.skipped ? ' (' + preview.skipped + ' duplicados ignorados)' : '') + '.');
        setPreview(null);
    };

    const onRestoreFile = async (file: File) => {
        try {
            const parsed = JSON.parse(await file.text());
            if (!parsed || parsed.app !== 'minhas-financas' || !Array.isArray(parsed.txs)) throw new Error('Esse arquivo não é um backup do Minhas Finanças.');
            setRestore({ txs: parsed.txs, cats: Array.isArray(parsed.cats) ? parsed.cats : [] });
        } catch (e: any) {
            setNotice(e && e.message ? e.message : 'Não consegui ler o backup.');
        }
        if (restoreInput.current) restoreInput.current.value = '';
    };

    const confirmRestore = () => {
        if (!restore) return;
        if (!persistTxs(restore.txs)) return;
        setCats(restore.cats);
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
                {catTotals.map(({ cat, cents }) => {
                    const c = catById(cat);
                    const max = catTotals[0].cents;
                    return <div className="bar" key={cat}>
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

            {menuOpen && <div className="overlay" onClick={() => setMenuOpen(false)}>
                <div className="sheet" onClick={e => e.stopPropagation()}>
                    <div className="sheethead"><h2>Opções</h2><button className="sheetx" aria-label="Fechar" onClick={() => setMenuOpen(false)}>✕</button></div>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); importInput.current && importInput.current.click(); }}>📥 Importar arquivo (Mobills, OFX, CSV)</button>
                    <button className="sheetbtn" onClick={exportBackup}>☁️ Exportar backup</button>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); restoreInput.current && restoreInput.current.click(); }}>↩️ Restaurar backup</button>
                    <button className="sheetbtn" onClick={() => { setMenuOpen(false); setShowInstall(true); }}>📲 Instalar na tela de início</button>
                    <button className="sheetbtn ghost" onClick={() => setMenuOpen(false)}>Fechar</button>
                </div>
            </div>}

            {showInstall && <div className="overlay" onClick={() => setShowInstall(false)}>
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
            </div>}

            {preview && <div className="overlay">
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
            </div>}

            {restore && <div className="overlay">
                <div className="sheet">
                    <div className="sheethead"><h2>Restaurar backup</h2><button className="sheetx" aria-label="Fechar" onClick={() => setRestore(null)}>✕</button></div>
                    <p>O backup tem {restore.txs.length} lançamentos. Restaurar <strong>substitui</strong> todos os dados atuais deste aparelho.</p>
                    <button className="sheetbtn primary" onClick={confirmRestore}>Substituir e restaurar</button>
                    <button className="sheetbtn ghost" onClick={() => setRestore(null)}>Cancelar</button>
                </div>
            </div>}

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

// ---------- formulário ----------

function TxForm(props: {
    initial: Tx | null;
    cats: Category[];
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
    const chosenCat = cat || (type === 'despesa' ? 'outros-d' : 'outros-r');

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

    return <div className="overlay">
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
                    {cats.map(c => <button key={c.id} className={'chip' + (chosenCat === c.id ? ' sel' : '')} onClick={() => setCat(c.id)}>
                        {c.icon} {c.label}
                    </button>)}
                </div>
                <div className="newcat">
                    <input type="text" placeholder="Nova categoria…" value={novaCat} onChange={e => setNovaCat(e.target.value)} />
                    <button className="chip" disabled={!novaCat.trim()} onClick={() => { const id = props.onAddCategory(novaCat.trim(), type); setCat(id); setNovaCat(''); }}>Adicionar</button>
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
    </div>;
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

    return <div className="overlay">
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
    </div>;
}
