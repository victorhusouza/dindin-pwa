# Minhas Finanças

App pessoal de finanças: registra despesas e receitas por categoria, acompanha contas fixas do mês e mostra o resumo (saldo, gastos por categoria e últimos 6 meses). Feito em React + TypeScript + Vite, sem backend: todos os dados ficam no navegador (localStorage) de cada aparelho.

## Rodar na sua máquina

Precisa de [Node.js](https://nodejs.org/) 18 ou superior.

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`.

## Publicar no GitHub Pages

```bash
npm run build
```

Isso gera a pasta `dist/` com o site pronto. Duas formas de publicar:

**Opção simples (branch gh-pages):**

```bash
npm install -g gh-pages
npx gh-pages -d dist
```

Depois, em Settings → Pages do repositório, escolha a branch `gh-pages`. O app fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`. O `vite.config.ts` já usa `base: './'`, então funciona em qualquer subcaminho sem ajuste.

**Opção GitHub Actions:** criar `.github/workflows/deploy.yml` com um workflow de build + deploy do `dist/` (o GitHub sugere um modelo pronto para Vite em Settings → Pages → GitHub Actions).

## Estrutura

```
index.html            página de entrada
vite.config.ts        config do build (base relativa p/ GitHub Pages)
public/               ícone e manifest (instalar como app na tela de início)
src/
  main.tsx            ponto de entrada React
  App.tsx             o app inteiro (telas, lançamentos, contas fixas, importação)
  localState.ts       hook que salva o estado no localStorage
  style.css           estilos (tema claro/escuro)
```

## Onde ficam os dados

Tudo no `localStorage` do navegador, em cada aparelho. Chaves `mf.*`:

- `mf.txs.0` a `mf.txs.7`: lançamentos (divididos em blocos para não estourar limite por chave)
- `mf.cats.v1`: categorias personalizadas
- `mf.recs.v1`: contas fixas (modelos com valor e dia de vencimento)
- `mf.theme.v1`: tema claro/escuro

Trocar de navegador ou aparelho não leva os dados (não há sincronização). O app tem exportar/importar backup (JSON) e importar extrato (OFX/CSV/XLSX) no menu ⋯.

## Categorias e contas fixas

O app vem com um conjunto básico de categorias de despesa e receita (`DEFAULT_CATS` em `App.tsx`). Dá para criar novas categorias e contas fixas direto no app; as contas fixas começam vazias (`SEED_RECS`) e cada pessoa cadastra as suas. "Pagar" uma conta fixa cria o lançamento do mês vinculado; dá para desfazer.

## Próximos passos naturais

- Contas/cartões e subcategorias
- Sincronização entre aparelhos (ex.: Supabase/Firebase)
- Publicar como app instalável (o manifest já permite "Adicionar à tela de início")

---

# Minhas Finanças (English)

A personal finance app: track expenses and income by category, manage recurring monthly bills, and see a summary (balance, spending by category, last 6 months). Built with React + TypeScript + Vite, no backend: all data stays in the browser's localStorage on each device.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. Build with `npm run build` (outputs `dist/`, ready for GitHub Pages or any static host).

## Data

Everything lives in localStorage under `mf.*` keys. No sync between devices. The app includes JSON backup export/import and statement import (OFX/CSV/XLSX) from the ⋯ menu. It ships with a basic set of categories and no preset bills — each user adds their own.

## License

MIT (see LICENSE). Contributions welcome.
