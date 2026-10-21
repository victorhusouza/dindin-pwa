import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' faz o app funcionar em qualquer subcaminho (ex.: usuario.github.io/minhas-financas/)
export default defineConfig({
    base: './',
    plugins: [react()],
    server: { proxy: { '/api': 'http://127.0.0.1:3100' } },
    preview: { proxy: { '/api': 'http://127.0.0.1:3100' } },
});
