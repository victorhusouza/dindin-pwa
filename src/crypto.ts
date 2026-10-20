// Backup criptografado: AES-256-GCM com chave derivada da senha via PBKDF2
// (SHA-256, 600 mil iteracoes), salt e IV aleatorios, formato versionado.
// Tudo com a WebCrypto do navegador: a senha nunca e salva nem sai do aparelho.

const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncBackupEnvelope {
    app: 'minhas-financas';
    version: 2;
    encrypted: true;
    exportedAt: string;
    kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
    cipher: { name: 'AES-256-GCM'; iv: string };
    data: string;
}

function toB64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function fromB64(b64: string): Uint8Array {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
}

async function deriveAesKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

export async function encryptBackupJson(plainJson: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plainJson));
    const envelope: EncBackupEnvelope = {
        app: 'minhas-financas',
        version: 2,
        encrypted: true,
        exportedAt: new Date().toISOString(),
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt) },
        cipher: { name: 'AES-256-GCM', iv: toB64(iv) },
        data: toB64(new Uint8Array(data)),
    };
    return JSON.stringify(envelope, null, 2);
}

export function isEncryptedBackup(parsed: unknown): parsed is EncBackupEnvelope {
    const p = parsed as EncBackupEnvelope | null;
    return !!p && p.app === 'minhas-financas' && p.encrypted === true && typeof p.data === 'string'
        && !!p.kdf && p.kdf.name === 'PBKDF2' && typeof p.kdf.salt === 'string' && typeof p.kdf.iterations === 'number' && p.kdf.iterations > 0
        && !!p.cipher && p.cipher.name === 'AES-256-GCM' && typeof p.cipher.iv === 'string';
}

// Erros: 'corrompido' (arquivo fora do formato) ou 'senha' (senha errada ou arquivo adulterado).
export async function decryptBackupJson(envelopeJson: string, password: string): Promise<string> {
    let parsed: unknown;
    try { parsed = JSON.parse(envelopeJson); } catch { throw new Error('corrompido'); }
    if (!isEncryptedBackup(parsed)) throw new Error('corrompido');
    try {
        const salt = fromB64(parsed.kdf.salt);
        const iv = fromB64(parsed.cipher.iv);
        const data = fromB64(parsed.data);
        const key = await deriveAesKey(password, salt, parsed.kdf.iterations);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource);
        return new TextDecoder().decode(plain);
    } catch {
        throw new Error('senha');
    }
}
