## Notas da versão v0.3.21

- Estamos aprimorando a interface no momento. Sugestões e comentários são bem-vindos no chat da comunidade ou no GitHub.

## Novidades

- Adicionado suporte à redefinição de cota para contas do Claude.

## Melhorias

- Melhorada a interface da página Consulta de cotas.

## Notas da versão v0.3.20

## Novidades

- Adicionados o gerenciamento de plugins e a Loja de plugins com instalação, atualizações, seleção de versão, controles para ativar/desativar, desinstalação, edição de configuração e autorização OAuth fornecida por plugins.
- Adicionada autorização por código de dispositivo OAuth para o Muse (Meta), além de suporte para detecção e inicialização do DeepSeek Harness Desktop no Windows.
- Adicionados prompts do sistema personalizados para modelos do Codex, com sincronização para o catálogo de modelos ao salvar e opção para restaurar os padrões do modelo.
- Adicionadas verificações de funcionamento de modelos em lote. Os registros de solicitações agora exibem o modelo real da resposta e sinalizam diferenças entre o modelo solicitado e o modelo da resposta.
- Adicionadas estimativas de custo por solicitação e exportação em CSV. O esforço de raciocínio agora é exibido por padrão para facilitar a revisão de uso e o diagnóstico de solicitações.

## Melhorias

- Atualizado o núcleo CLIProxyAPI incluído para a versão **8.0.13** e alinhadas as chamadas da API de gerenciamento e a edição de configurações à v8.
- Redesenhados o painel inicial, a análise de uso e as principais páginas de gerenciamento com superfícies consistentes no tema claro, navegação e tabelas aprimoradas, melhor contraste no modo escuro e layouts otimizados para janelas estreitas.
- Reformulado o gerenciamento de credenciais em uma lista compacta que exibe planos, status, estatísticas de solicitações e cotas, com paginação, controles para ativar/desativar, detalhes expansíveis e contagens regressivas e controles de redefinição do período de espera aprimorados.
- Expandidas as configurações estruturadas para solicitações, OAuth, plugins, concorrência e provedores, com busca, validação, avisos de conflito, restauração de padrões e avisos de reinicialização aprimorados.
- Adicionado suporte a grupos nativos de provedores da v8 e à edição, remoção e reordenação individual de credenciais em Acesso à API. Aliases de modelos agora têm uma aba dedicada.
- Adicionados busca, paginação e salvamento das preferências de exibição na lista de clientes, ampliada a detecção de caminhos de instalação e priorizados os clientes instalados.
- Adicionada a opção “Instalar o núcleo incluído” no Gerenciamento de versões para instalar diretamente a partir do pacote local do núcleo incluído no aplicativo.

## Correções

- Corrigida a migração de configurações v7 e em formato misto para v8, aprimorada a preservação de chaves, provedores, aliases de modelos e campos personalizados, e evitado que atualizações externas sobrescrevam rascunhos de configuração não salvos.
- Corrigida a mistura de estados de período de espera entre credenciais de mesmo nome de contas diferentes e corrigido o problema em que atualizações de exclusões de modelos OAuth afetavam outros provedores.
- Corrigida a agregação de custos para solicitações com diferentes tamanhos de contexto e esclarecida a parcela do uso coberta pelas estimativas de custo.
- Corrigidas a validação de origem de aliases de modelos e o uso inconsistente de IDs de modelos do Codex, além de preservar plugins instalados e dados de execução ao recompilar distribuições portáteis.
