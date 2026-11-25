## Melhorias

- O Claude Code agora exibe os modelos no formato “Função · nome do modelo”, adiciona o marcador `[1m]` aos modelos com 1M ativado e mostra claramente o tamanho da janela de compactação automática.
- Adicionado o filtro “Usar aliases de modelos” aos mapeamentos de modelos do Claude Desktop para alternar entre modelos originais e aliases.

## Correções

- Corrigido o erro `OpenCode is not installed` exibido na configuração com um clique após selecionar manualmente o executável do OpenCode para desktop ([#389](https://github.com/router-for-me/EasyCLIProxyAPI/issues/389)). Aplicar, atualizar e ativar configurações de agentes agora respeita os caminhos de executável configurados.
- Corrigido o problema em que a instalação, atualização e desinstalação do plugin do Pi ignoravam o caminho de CLI configurado manualmente.
- Corrigida a ocultação de modelos originais no Claude Code e no Claude Desktop quando havia aliases configurados. Desativar “Usar aliases de modelos” agora mantém todos os modelos originais disponíveis pesquisáveis e selecionáveis. Essa correção vale para todos os modelos.
- Corrigido o problema em que ativar 1M no Claude Code sobrescrevia uma janela de compactação automática personalizada. Os valores padrão de 200K / 1M continuam acompanhando a opção; outros valores personalizados são preservados.
- Completadas as gravações de configuração da janela de contexto e da janela de compactação automática do Claude Code para manter as configurações relacionadas consistentes.
- Corrigido o problema em que o Fable não herdava a configuração de 1M do Sonnet ao usar o Sonnet como alternativa sem um mapeamento separado.

---

## v0.3.30

## Novidades

- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [Discord](https://discord.gg/PxvX4D9kgs) ou envie pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.
- Agentes que possuem tanto programa de linha de comando quanto aplicativo para desktop — Codex, OpenCode e DeepSeek Harness — agora podem usar caminhos separados. Quando a detecção automática falhar, a inicialização e a detecção usam o caminho correspondente.
- Um alias de modelo agora pode ser compartilhado por várias origens. Aliases idênticos podem ser editados e excluídos de forma independente, sem sobrescrever uns aos outros.

## Melhorias

- Redesenhada a barra lateral com navegação mais compacta e indicação mais clara da página atual. O Modo iniciante e o contato agora são entradas simples, e os controles de idioma e tema compartilham a mesma barra de ferramentas.
- Ajustada a lista de aliases de modelos para que níveis de raciocínio e selos Fast não desloquem os botões de editar e excluir.
- A página Configuração de agentes mantém o modelo selecionado. Se uma atualização omitir temporariamente esse modelo, a seleção não é substituída pelo primeiro item, e a página informa que ele está indisponível.
- O progresso da atualização do aplicativo agora exibe apenas a etapa atual, evitando que o texto de progresso se repita ou salte.
- Renomeada a recuperação de sessões para “Sincronizar sessões do histórico”, esclarecendo que o ChatGPT mantém as conversas de cada API separadas. Conversas antigas podem ser sincronizadas em Gerenciamento de sessões.

## Correções

- A página Acesso à API agora lembra a última categoria de provedor selecionada.
- Salvar um alias de modelo agora preserva alterações de configuração não relacionadas.
