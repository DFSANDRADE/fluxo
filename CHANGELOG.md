# Changelog

Todas as mudanças relevantes do Fluxo. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.2.2] — 2026-11-25

Gerenciar o histórico e reproduzir melhor o conteúdo convertido.

### Adicionado
- **Excluir do histórico:** cada item ganhou um 🗑. Item só **assistido** some na hora (é um registro local); item **baixado** confirma antes, porque remover de vez também apaga o arquivo baixado (e avisa que não dá pra desfazer).
- **Limpar histórico:** botão **🧹 Limpar** zera de uma vez os assistidos e o "continuar assistindo". Os arquivos baixados **continuam** — para apagar um, use o 🗑 dele.

### Corrigido
- **Conteúdo convertido retoma de onde parou:** vídeo que o servidor converte na hora (HEVC/4K do provedor ou arquivo local em codec antigo) recomeçava do zero ao reconectar depois de um travamento. Agora o servidor reabre a conversão no ponto exato (o player passa a posição com `?t=`) tanto na reconexão quanto ao trocar para o modo de conversão.
- **Menos pixelização** (quadradinhos de cor) no conteúdo convertido: keyframe a cada ~1 s (recupera de um engasgo em cerca de metade do tempo) e descarte de pacote corrompido em vez de mostrar bloco quebrado. O ajuste de baixa latência passou a valer só para canais ao vivo — no VOD a imagem fica mais estável.
- **Diagnóstico mais honesto:** quando provedor e servidor estão no ar, o "Travou ou tá ruim?" não culpa mais a sua rede/Tailscale por padrão — diz que está tudo normal e que o engasgo foi passageiro.

## [0.2.1] — 2026-11-17

Correção pontual de reprodução.

### Corrigido
- **Voltar de onde parou após cair de rede:** quando um filme ou episódio caía por queda de rede (não só travamento), o player reconectava e **voltava para o começo, se comportando como se fosse ao vivo**. Causa: numa queda de rede o navegador zera a posição do vídeo, e a posição de retomada só era guardada no início da reprodução. Agora a posição é atualizada continuamente e o player sempre reconecta no ponto exato em que estava.

## [0.2.0] — 2026-11-09

Release focada em **resiliência** (não cair, não sumir conteúdo) e em **tocar o que antes não tocava**.

### Adicionado
- **Navegação de episódios no player:** botões ⏮ Anterior / Próximo ⏭ agrupados na caixa de "próximo episódio", que some sozinha em tela cheia. Funcionam inclusive ao retomar um episódio pelo **Histórico** ou **Continuar assistindo** (o app guarda um mapa episódio→série e rebusca a temporada no provedor).
- **Cache do catálogo em disco:** o catálogo sobrevive a reinício do serviço **e** a quedas do provedor. Um auto-recuperador tenta sozinho a cada 5 min e preenche assim que o provedor volta — sem precisar reiniciar nada.
- **Conversão automática de arquivos locais com codec antigo:** torrents e DvdRips em DivX/Xvid (MPEG-4 Part 2) que só davam áudio com tela preta agora tocam — o servidor converte pra H.264 na hora, com aviso claro na tela.
- **Status real do provedor no diagnóstico:** o painel "Travou ou tá ruim?" mostra se o provedor está **no ar** ou **FORA (HTTP xxx)**.

### Corrigido
- **Catálogo não some mais** quando o provedor pisca ou devolve erro (502/503): o último catálogo bom é mantido em vez de ser sobrescrito por vazio.
- **Servidor não cai mais** quando o cliente fecha o vídeo no meio da reprodução (`ERR_STREAM_WRITE_AFTER_END`): fim do loop de reinícios que obrigava a clicar no botão de manutenção.
- **Reconexão automática mais rápida** no travamento (~6s, era 12s), com mensagem clara de que está se recuperando sozinho.
- **Diagnóstico honesto:** parou de culpar a rede do usuário quando o problema é o provedor (antes só media latência; um 502 responde rápido e enganava o diagnóstico).

## [0.1.0]

- Versão inicial publicada: player IPTV web (ao vivo, filmes, séries), busca unificada, EPG/guia, perfis com perfil **Kids** (filtro de conteúdo, sem aba Torrents, PIN), tela de administração de provedores, downloads offline + cache temporário, integração com torrents (Jackett) e transcode de HEVC/4K → H.264.
