import { useState } from 'react';
import { notifyChange } from './sync';

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
        setValue(v);
        try {
            window.localStorage.setItem(key, JSON.stringify(v));
            notifyChange(key); // enfileira a mudanca para o sync com a VM
            return true;
        } catch {
            // sem acesso ao armazenamento: mantém só em memória
            return false;
        }
    };

    return [value, set, { ready: true, message: '' }];
}
