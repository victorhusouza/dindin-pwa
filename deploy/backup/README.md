# Backup diário cifrado (exemplo)

Rotina opcional de backup do servidor: snapshot diário do SQLite, cifrado com a
**sua chave pública GPG** (só a sua chave privada abre) e enviado para **duas
nuvens com confirmação de conteúdo** — Proton Drive (via
[CLI oficial](https://github.com/ProtonDriveApps/sdk/tree/main/cli)) e Backblaze
B2 (via [rclone](https://rclone.org)). Uma terceira nuvem (Google Drive) é
opcional e não participa da confirmação.

Como funciona cada dia:

1. **Snapshot** (`dindin-snapshot`, 04:17): cópia consistente do banco via
   `sqlite3 .backup`. Sem poda por idade — nada é apagado por ficar velho.
2. **Cifragem** (`dindin-backup-upload`, 04:27): GPG com a sua pública, de forma
   atômica (arquivo temporário + renomear). Um sidecar `.meta` vincula o `.gpg`
   ao snapshot pelo sha256; reuso só acontece com o vínculo conferindo.
3. **Envio com confirmação de conteúdo** (não basta o upload "não dar erro"):
   - B2: `rclone copy` (confere SHA1 no envio) + `rclone check` (hash remoto);
   - Proton Drive: tamanho remoto declarado == local **e** download do `.gpg`
     recém-enviado com sha256 idêntico (não usa a chave privada).
4. **Portão**: só depois das DUAS confirmações o script grava um marcador `.ok`
   e apaga a cópia local sem cifra do dia. Sem confirmação, os arquivos ficam
   (nunca são apagados por idade) e o log avisa.
5. **Cópias locais**: os 14 dias mais novos COM marcador válido ficam na pasta
   (`.gpg` cifrados); o resto da rotação local só toca em arquivo confirmado.
6. **Retenção nas nuvens**: todos os dias dos últimos 30 dias + 1 arquivo por
   mês dos últimos 12 meses (dia 30; em fevereiro, o último dia) + paranoia: os
   5 mais recentes sempre ficam. O resto é apagado automaticamente.

O log usa marcadores fáceis de vigiar: `GPG_CIFRADO`/`GPG_REUSADO`,
`LOCAL APAGAR`/`LOCAL MANTER`, `PROTON_FALHOU`/`B2_FALHOU`/`RETENCAO_FALHOU`,
`*_TENTATIVA_*` (retries), `SNAPSHOT_DE_HOJE_AUSENTE`.

Se a cifragem falhar, o script aborta **sem subir nada** — backup em texto puro
nunca vai para a nuvem por este caminho.

## Instalação (resumo)

1. Gere um par de chaves dedicado, com senha, no SEU computador:
   `gpg --quick-generate-key "dindin backup <voce@seu-dominio>" rsa4096 encr never`
   e exporte a pública: `gpg --armor --export voce@seu-dominio > backup-pubkey.asc`.
   Guarde a chave privada e a senha no seu gerenciador de senhas.
2. No servidor: copie `dindin-snapshot.example` e `dindin-backup-upload.example`
   para `/usr/local/bin/` (sem o sufixo), `chmod +x`, ajuste caminhos e usuário.
3. Coloque a pública em `/usr/local/share/dindin/backup-pubkey.asc` e ajuste
   `DINDIN_BACKUP_FP` no script (o fingerprint da sua chave — o script confere a
   cada execução e não sobe nada se não bater).
4. Configure os remotes do rclone (`gdrive:dindin-backups`, `b2:dindin-backup`)
   e o login do Proton Drive CLI com o usuário que roda o backup, e instale o
   agendamento (`dindin-backup.cron.example`). Nomes de pastas/remotes são
   variáveis no topo do script.
5. Teste: cifre um arquivo de teste no servidor e decifre no seu computador
   (`gpg --decrypt arquivo.gpg`) antes do primeiro envio real. Para testar a
   retenção sem apagar nada: `RETENTION_DRY_RUN=1`.

Limite honesto: o vínculo `.meta` protege contra corrupção acidental; um invasor
com escrita no servidor poderia recifrar com a chave pública (que é pública) e
forjar o sidecar. É integridade contra acidente, não contra invasor.
