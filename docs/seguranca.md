# Segurança do Minhas Finanças (servidor próprio)

Este documento descreve o modelo de segurança do servidor opcional (pasta `api/`),
que adiciona login, sincronização entre aparelhos e histórico de alterações ao app.
Todos os valores são do código atual; nenhum dado real, senha, chave ou domínio
aparece neste repositório.

## Visão geral

- O app (PWA) fala apenas com a própria API, em caminhos relativos `/api/*`.
- A API (Node.js, sem framework, SQLite com WAL) escuta só em `127.0.0.1`, atrás
  do Caddy, que termina o HTTPS (certificado automático). Veja `deploy/`.
- Configuração por variáveis de ambiente (`PORT`, `HOST`, `DATA_DIR`). Nenhum
  segredo no código.

## Login: usuário e senha

- Um único usuário, criado na primeira visita (tela de "primeiro acesso").
- Nome de usuário normalizado para minúsculas; aceita letras, números, ponto,
  traço e sublinhado (3 a 30 caracteres).
- Senha com no mínimo 10 caracteres, misturando letras e números.
- A senha nunca é armazenada em texto: o banco guarda apenas
  `scrypt(N=16384, r=8, p=1)` com salt aleatório de 16 bytes, por senha.
- A verificação usa comparação em tempo constante (`timingSafeEqual`) e, quando
  o usuário não existe, calcula o hash contra um valor falso para igualar o
  tempo de resposta (não vaza se o usuário existe).

## Erros e bloqueio de tentativas

- Erro de login sempre genérico: "Usuário ou senha incorretos." — não revela
  qual dos dois estava errado.
- Bloqueio por IP: 5 falhas consecutivas (somando usuário errado e senha errada)
  bloqueiam novas tentativas por 15 minutos (resposta 429). Login com sucesso
  zera o contador.

## Sessões

- Token aleatório de 32 bytes por sessão; o banco guarda apenas o SHA-256 do
  token, nunca o token em si.
- Cookie `HttpOnly; Secure; SameSite=Lax` — inacessível a JavaScript e não
  enviado em requisições entre sites.
- Validade deslizante de 7 dias (renova a cada uso) com teto absoluto de 30 dias.
- Logout apaga a sessão no servidor.

## Dados e sincronização

- Cada registro (lançamento, categoria, conta fixa, regra de categorização) é
  sincronizado individualmente; em conflito, a última edição vence (por
  timestamp do aparelho, com tolerância de 5 minutos de relógio adiantado).
- Excluir é "exclusão suave": o registro fica marcado como apagado no servidor
  e pode ser recuperado.
- Cada criação, edição e exclusão gera uma linha no histórico com o que mudou,
  o conteúdo antes e depois, o aparelho e a hora.
- Corpo de requisição limitado a 1 MB; dados validados no servidor.

## Serviço no sistema

- Roda como usuário sem privilégios dedicado, com `NoNewPrivileges` e
  `ProtectSystem` (veja `deploy/dindin-api.service.example`).
- Banco de dados fora da raiz pública do site, acessível só pelo usuário do
  serviço.

## Planejado (não implementado)

- Segundo fator (TOTP, código de app autenticador) em uma versão futura.
