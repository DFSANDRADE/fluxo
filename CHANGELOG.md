# Changelog

Todas as mudanças relevantes do Fluxo. Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e [Versionamento Semântico](https://semver.org/lang/pt-BR/).

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
