## Notas da versão v0.3.23

- O projeto está aprimorando sua interface no momento. Sugestões e comentários são bem-vindos no chat da comunidade ou no GitHub.

## Novidades

- As configurações avançadas de credenciais agora são um formulário. Cada credencial pode definir aliases de modelos com prioridade sobre os aliases globais, além de ocultação de solicitações do Claude, impressões digitais da solicitação, fuso horário e cabeçalhos personalizados.
- A exportação em CSV dos registros de solicitações agora permite escolher onde salvar o arquivo.

## Melhorias

- O esforço de raciocínio agora aparece abaixo do nome do modelo nos registros de solicitações, em vez de ocupar uma coluna própria. A paginação e o redimensionamento de colunas mantêm a lista atual visível.
- A Consulta de cotas agora filtra por categoria em vez de empilhar credenciais em grupos de provedores.
- O Modo iniciante conta as plataformas conectadas por grupo de provedores, inclui Vertex, xAI e Meta entre as plataformas compatíveis e usa o ícone da Meta.

## Correções

- Corrigida a exibição do estado desativado para API Keys individuais. Chaves desativadas ficam esmaecidas, grupos com apenas algumas chaves desativadas são sinalizados e a dica de estado vazio informa a ação correta de adição.

## Notas da versão v0.3.22

- O projeto está aprimorando sua interface no momento. Sugestões e comentários são bem-vindos no chat da comunidade ou no GitHub.

## Novidades

- Adicionado suporte à redefinição de cota para contas do Claude.

## Correções

- Corrigidos problemas de layout na página Consulta de cotas.

## Notas da versão v0.3.21
## Novidades

- Adicionados o gerenciamento de plugins e a Loja de plugins com suporte para instalação, atualizações, seleção de versão, ativação e desativação, desinstalação, edição de configuração e autorização OAuth fornecida por plugins.
- Adicionada autorização por código de dispositivo OAuth para o Muse (Meta), além de suporte para detectar e iniciar o DeepSeek Harness Desktop no Windows.
- Adicionado suporte a prompts do sistema personalizados para modelos do Codex. Os prompts salvos são sincronizados com o catálogo de modelos, e os padrões do modelo podem ser restaurados.
- Adicionadas verificações de funcionamento de modelos em lote. Os registros de solicitações agora mostram o modelo real da resposta e sinalizam casos em que ele difere do modelo solicitado.
- Adicionadas estimativas de custo por solicitação e exportação em CSV aos registros de solicitações. O esforço de raciocínio é exibido por padrão para facilitar a revisão de uso e o diagnóstico de problemas.

## Melhorias

- Atualizado o núcleo CLIProxyAPI incluído para a versão **8.0.13** e adaptados a API de gerenciamento e o editor de configurações para a v8.
- Redesenhados o painel inicial, a análise de uso e as principais páginas de gerenciamento com tema claro consistente, navegação e estilo de tabelas aprimorados; melhorados o contraste no modo escuro e os layouts para janelas estreitas.
- Reformulado o gerenciamento de credenciais em uma lista compacta que exibe planos, status, estatísticas de solicitações e cotas, com paginação, controles para ativar/desativar, detalhes expansíveis e contagens regressivas e operações de redefinição do período de espera aprimoradas.
- Adicionadas mais configurações estruturadas para solicitações, OAuth, plugins, concorrência e provedores; melhorados a busca, validação, avisos de conflito, restauração de padrões e avisos de reinicialização.
- Adicionado suporte em Acesso à API para grupos nativos de provedores da v8 e edição, exclusão e reordenação por credencial. Aliases de modelos são exibidos em uma aba separada.
- Adicionados busca, paginação e preferências de exibição salvas à lista de clientes; ampliada a detecção de caminhos de instalação e priorizados os clientes instalados.
- Adicionada a opção “Instalar o núcleo incluído” no Gerenciamento de versões, permitindo instalar diretamente a partir do pacote local do núcleo incluído no aplicativo.

## Correções

- Corrigidas a migração da v7 para a v8 e a migração de configurações em formato misto; aprimorada a preservação de chaves, provedores, aliases de modelos e campos personalizados, e evitado que atualizações externas sobrescrevam rascunhos de configuração não salvos.
- Corrigida a mistura de estados de período de espera entre credenciais de mesmo nome de contas diferentes, e corrigido o problema em que atualizações de exclusão de modelos OAuth afetavam outros provedores.
- Corrigida a agregação de custos quando solicitações com diferentes tamanhos de contexto são combinadas, e melhorada a exibição da cobertura das estimativas de custo.
- Corrigidas a validação de origem de aliases de modelos e o uso inconsistente de IDs de modelos do Codex; plugins instalados e dados de execução agora são preservados ao recompilar distribuições portáteis.
