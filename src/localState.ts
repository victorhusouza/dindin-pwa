import { useState } from 'react';

// Armazenamento local do navegador (localStorage).
// Mesma assinatura do hook usado na versão hospedada: [valor, setter, { ready, message }].
// Se o navegador bloquear o armazenamento (modo privado etc.), o app continua
// funcionando em memória até a página ser fechada.
export interface LocalStateMeta {
    ready: boolean;
    message: string;
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void, LocalStateMeta] {
    const [value, setValue] = useState<T>(() => {
        try {
            const raw = window.localStorage.getItem(key);
            if (raw != null) return JSON.parse(raw) as T;
        } catch {
            // sem acesso ao armazenamento: usa o valor inicial em memória
        }
        return initial;
    });

    const set = (v: T) => {
        setValue(v);
        try {
            window.localStorage.setItem(key, JSON.stringify(v));
        } catch {
            // sem acesso ao armazenamento: mantém só em memória
        }
    };

    return [value, set, { ready: true, message: '' }];
}
