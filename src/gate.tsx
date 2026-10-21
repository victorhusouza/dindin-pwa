// Porta de entrada do app: setup da senha (primeiro uso), login, hidratacao
// do estado vindo da VM e, logado, o app + botoes de Historico e Sair.
import React, { useCallback, useEffect, useState } from 'react';
import { hydrate, startSyncLoop, setAuthLostHandler, deviceLabel } from './sync';

type Stage = 'loading' | 'setup' | 'login' | 'hydrating' | 'ready';

interface HistoryEntry { seq: number; ts: number; device: string; entity: string; rid: string; op: string; before: any; after: any }

const ENTITY_LABEL: Record<string, string> = { tx: 'Lançamento', cat: 'Categoria', rec: 'Conta fixa', catrule: 'Sugestão', pref: 'Preferência' };
const OP_LABEL: Record<string, string> = { create: 'criado', update: 'alterado', delete: 'apagado' };

function entryName(e: HistoryEntry): string {
    const r = e.after || e.before || {};
    return r.desc || r.label || r.key || e.rid;
}

function HistoryModal({ onClose }: { onClose: () => void }) {
    const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
    const [err, setErr] = useState('');
    useEffect(() => {
        fetch('/api/history?limit=100', { credentials: 'same-origin' })
            .then(r => { if (!r.ok) throw new Error(); return r.json(); })
            .then(b => setEntries(b.entries || []))
            .catch(() => setErr('Não consegui carregar o histórico agora.'));
    }, []);
    return <div style={overlayStyle} onClick={onClose}>
        <div style={modalStyle} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong>Histórico de alterações</strong>
                <button onClick={onClose} style={xStyle}>✕</button>
            </div>
            {err && <p style={{ color: '#f87171' }}>{err}</p>}
            {!entries && !err && <p>Carregando…</p>}
            {entries && entries.length === 0 && <p>Nenhuma alteração ainda.</p>}
            {entries && entries.map(e => <div key={e.seq} style={{ padding: '8px 0', borderBottom: '1px solid #334155', fontSize: 14 }}>
                <div>{ENTITY_LABEL[e.entity] || e.entity} {OP_LABEL[e.op] || e.op}: <strong>{entryName(e)}</strong></div>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>{new Date(e.ts).toLocaleString('pt-BR')} · {e.device || 'aparelho'}</div>
            </div>)}
        </div>
    </div>;
}

const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modalStyle: React.CSSProperties = { background: '#1e293b', color: '#e2e8f0', borderRadius: 12, padding: 20, maxWidth: 420, width: '100%', maxHeight: '80vh', overflowY: 'auto' };
const xStyle: React.CSSProperties = { background: 'none', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '12px', marginTop: 10, borderRadius: 8, border: '1px solid #475569', background: '#0f172a', color: '#e2e8f0', fontSize: 16, boxSizing: 'border-box' };
const btnStyle: React.CSSProperties = { width: '100%', padding: '12px', marginTop: 14, borderRadius: 8, border: 'none', background: '#e8833a', color: '#171315', fontSize: 16, fontWeight: 700, cursor: 'pointer' };

export function Gate({ children }: { children: React.ReactNode }) {
    const [stage, setStage] = useState<Stage>('loading');
    const [user, setUser] = useState('');
    const [pw, setPw] = useState('');
    const [pw2, setPw2] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [showHistory, setShowHistory] = useState(false);

    const afterAuth = useCallback(async () => {
        setStage('hydrating');
        try { await hydrate(); startSyncLoop(); setStage('ready'); }
        catch { setErr('Sem conexão com o servidor. Tente de novo.'); setStage('login'); }
    }, []);

    useEffect(() => {
        setAuthLostHandler(() => setStage('login'));
        fetch('/api/auth/status', { credentials: 'same-origin' })
            .then(r => r.json())
            .then(b => { if (!b.setup) { setStage('setup'); } else if (!b.authed) setStage('login'); else void afterAuth(); })
            .catch(() => { setErr('Sem conexão com o servidor.'); setStage('login'); });
    }, [afterAuth]);

    const submit = async (path: string, body: Record<string, string>) => {
        setBusy(true); setErr('');
        try {
            const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
            const b = await r.json().catch(() => ({}));
            if (!r.ok) { setErr(b.error || 'Não deu certo. Tente de novo.'); return; }
            await afterAuth();
        } catch { setErr('Sem conexão com o servidor.'); }
        finally { setBusy(false); }
    };

    const logout = async () => {
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* offline */ }
        window.location.reload();
    };

    if (stage === 'ready') return <>
        {children}
        <div style={{ position: 'fixed', left: 10, bottom: 10, zIndex: 900, display: 'flex', gap: 8 }}>
            <button onClick={() => setShowHistory(true)} title="Histórico de alterações" style={fabStyle}>🕘</button>
            <button onClick={() => void logout()} title="Sair" style={fabStyle}>⏻</button>
        </div>
        {showHistory && <HistoryModal onClose={() => setShowHistory(false)} />}
    </>;

    const isSetup = stage === 'setup';
    return <div style={{ minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ width: '100%', maxWidth: 360 }}>
            <div style={{ textAlign: 'center', fontSize: 44 }}>💰</div>
            <h1 style={{ textAlign: 'center', fontSize: 24, margin: '8px 0 4px' }}>dindin</h1>
            <p style={{ textAlign: 'center', color: '#94a3b8', marginTop: 0 }}>
                {stage === 'loading' || stage === 'hydrating' ? 'Carregando…' : isSetup ? 'Primeiro acesso: confirme o usuário e crie a sua senha.' : 'Entre com usuário e senha.'}
            </p>
            {(stage === 'setup' || stage === 'login') && <form onSubmit={e => {
                e.preventDefault();
                if (isSetup) void submit('/api/auth/setup', { username: user, password: pw, confirm: pw2, device: deviceLabel() });
                else void submit('/api/auth/login', { username: user, password: pw, device: deviceLabel() });
            }}>
                <input type="text" value={user} onChange={e => setUser(e.target.value)} placeholder="Usuário" autoFocus={!isSetup} style={inputStyle} autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Senha" autoFocus={isSetup} style={inputStyle} autoComplete={isSetup ? 'new-password' : 'current-password'} />
                {isSetup && <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Repita a senha" style={inputStyle} autoComplete="new-password" />}
                {isSetup && <p style={{ fontSize: 13, color: '#94a3b8' }}>Pelo menos 10 caracteres, misturando letras e números. Guarde no Proton Pass.</p>}
                {err && <p style={{ color: '#f87171', fontSize: 14 }}>{err}</p>}
                <button type="submit" disabled={busy || !user.trim() || !pw || (isSetup && !pw2)} style={{ ...btnStyle, opacity: busy || !user.trim() || !pw || (isSetup && !pw2) ? .5 : 1 }}>
                    {busy ? 'Um momento…' : isSetup ? 'Criar senha e entrar' : 'Entrar'}
                </button>
            </form>}
        </div>
    </div>;
}

const fabStyle: React.CSSProperties = { width: 40, height: 40, borderRadius: '50%', border: '1px solid #475569', background: 'rgba(15,23,42,.85)', color: '#e2e8f0', fontSize: 17, cursor: 'pointer' };
