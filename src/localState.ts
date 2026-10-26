import { useState } from 'react';
import { notifyChange, avisoPersistente } from './sync';

// Armazenamento local do navegador (localStorage).
// Mesma assinatura do hook usado na versão hospedada: [valor, setter, { ready, message }].
// Se o navegador bloquear o armazenamento (modo privado etc.), o app continua
// funcionando em memória até a página ser fechada.
export interface LocalStateMeta {
    ready: boolean;
    message: string;
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => boolean, LocalStateMeta] {
    const [value, setValue] = useState<T>(() => {
        try {
            const raw = window.localStorage.getItem(key);
            if (raw != null) return JSON.parse(raw) as T;
        } catch {
            // sem acesso ao armazenamento: usa o valor inicial em memória
        }
        return initial;
    });

    // Retorna false quando a gravação não persistiu (sem espaço ou acesso bloqueado),
    // para quem chama decidir se tenta de novo ou avisa. O estado em memória sempre atualiza.
    const set = (v: T): boolean => {
        let oldRaw: string | null = null;
        try { oldRaw = window.localStorage.getItem(key); } catch { /* sem acesso */ }
        setValue(v);
        try {
            window.localStorage.setItem(key, JSON.stringify(v));
        } catch {
            // sem acesso ao armazenamento: mantém só em memória
            return false;
        }
        if (!notifyChange(key)) {
            // Intencao NAO enfileirada (quota na fila/snap): reverte a gravacao
            // para o valor anterior — colecao e snap continuam consistentes, o
            // oficial nao estompa nada e o chamador avisa (o rascunho fica
            // preservado no formulario aberto).
            try { if (oldRaw === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, oldRaw); } catch { avisoPersistente('falha ao restaurar a gravacao anterior — exporte um backup'); }
            try { setValue(oldRaw === null ? initial : JSON.parse(oldRaw) as T); } catch { /* melhor esforco */ }
            return false;
        }
        return true;
    };

    return [value, set, { ready: true, message: '' }];
}
