## Novidades

- A página de Gerenciamento de versões agora exibe as notas da versão do software e a data de publicação da versão mais recente.
- As notas da versão oferecem suporte a chinês simplificado, chinês tradicional, inglês e japonês, acompanhando o idioma da interface. É possível expandir ou recolher as notas, além de acessar o link para a página completa da versão. Quando faltar tradução, é exibido um aviso em vez do conteúdo em outro idioma.

## Melhorias

- Melhorada a rolagem horizontal nos detalhes das solicitações da página Histórico de uso, corrigindo travamentos e saltos no conteúdo durante o arraste rápido. As posições e os limites de rolagem permanecem sincronizados ao redimensionar a janela ou as colunas, ou ao alterar as colunas visíveis.
- Atualizadas as orientações de registro de logs para explicar quais solicitações com falha são gravadas e lembrar de desativar "Gravar logs em arquivos" quando não for mais necessário, evitando uso excessivo de armazenamento.

## Correções

- Corrigido o salvamento de conexões do Claude e do Codex que compartilham a mesma API Key e Base URL, mas usam mapeamentos de modelos ou prioridades diferentes. Configurações idênticas continuam sendo rejeitadas como duplicadas. ([#276](https://github.com/router-for-me/EasyCLIProxyAPI/issues/276))
- Corrigida a interferência entre conexões que compartilham uma API Key ao editar, ativar/desativar, reordenar, excluir ou gerenciar observações. As observações existentes são preservadas e migradas, e as ações afetam apenas a conexão selecionada.
- Melhorada a restauração de configurações ao desconectar integrações de agentes, preservando os ajustes feitos pelo usuário após a conexão. Modelos personalizados de subagentes do Claude Code e configurações de acesso de rede do Claude Desktop Cowork também são preservados.
- Corrigida a remoção da configuração do provedor ao restaurar a configuração nativa do Codex ou desconectar a integração, mantendo a configuração necessária para as sessões do histórico.
