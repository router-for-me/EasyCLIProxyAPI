- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Novidades

- Etiquetas personalizadas de credenciais e gerenciamento de grupos em lote: adicionado suporte a etiquetas personalizadas (`tags`) para contas OAuth e de credenciais, com selos de etiqueta nos cartões de credenciais e filtro por etiqueta na lista de contas. O diálogo de Gerenciamento em lote agora permite selecionar um grupo inteiro pela etiqueta para ativar, desativar, atualizar ou excluir as credenciais de uma vez ([#546](https://github.com/router-for-me/EasyCLIProxyAPI/issues/546)).

## Correções

- Desalinhamento do menu suspenso do tema de anime e saltos de layout: corrigido um problema em que o `backdrop-filter`, no tema claro de anime ou com imagem de fundo, criava blocos de contenção que deslocavam os menus suspensos de `AgentModelPicker` para o canto inferior direito da tela. Adicionada compensação de coordenadas do `offsetParent` do bloco de contenção e removidas margens anormais nas abas secundárias e nos títulos de página ([#543](https://github.com/router-for-me/EasyCLIProxyAPI/pull/543)).
