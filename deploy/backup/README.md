# Backup diário cifrado (exemplo)

Rotina opcional de backup do servidor: snapshot diário do SQLite, cifrado com a
**sua chave pública GPG** (só a sua chave privada abre) e enviado para dois
destinos — Google Drive (via [rclone](https://rclone.org)) e Proton Drive (via
[CLI oficial](https://github.com/ProtonDriveApps/sdk/tree/main/cli)).

Retenção nas nuvens: todos os dias dos últimos 30 dias + 1 arquivo por mês dos
últimos 12 meses (dia 30; em fevereiro, o último dia). O resto é apagado
automaticamente. Snapshots locais: últimos 30 dias.

## Instalação (resumo)

1. Gere um par de chaves dedicado, com senha, no SEU computador:
   `gpg --quick-generate-key "dindin backup <voce@seu-dominio>" rsa4096 encr never`
   e exporte a pública: `gpg --armor --export voce@seu-dominio > backup-pubkey.asc`.
   Guarde a chave privada e a senha no seu gerenciador de senhas.
2. No servidor: copie `dindin-snapshot.example` e `dindin-backup-upload.example`
   para `/usr/local/bin/` (sem o sufixo), `chmod +x`, ajuste caminhos e usuário.
3. Coloque a pública em `/usr/local/share/dindin/backup-pubkey.asc` e ajuste
   `FP_ESPERADO` no script (o fingerprint da sua chave — o script confere a cada
   execução e não sobe nada se não bater).
4. Configure o rclone (`gdrive:dindin-backups`) e o login do Proton Drive CLI
   com o usuário que roda o backup, e instale o agendamento (`dindin-backup.cron.example`).
5. Teste: cifre um arquivo de teste no servidor e decifre no seu computador
   (`gpg --decrypt arquivo.gpg`) antes do primeiro envio real.

Se a cifragem falhar, o script aborta **sem subir nada** — backup em texto puro
nunca vai para a nuvem por este caminho.
