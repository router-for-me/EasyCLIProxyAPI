- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- **Atualização sob demanda do catálogo de modelos**: a página Início agora conta com um botão de atualização para buscar o catálogo de modelos quando você solicitar, em vez de sincronizá-lo periodicamente em segundo plano. Menos solicitações desnecessárias e menos espera na interface.

## Correções

- **A sincronização do catálogo do Codex não roda mais em segundo plano**: a sincronização automática em segundo plano foi removida e passa a ser acionada pela atualização manual na página Início, evitando que sua lista de modelos seja reescrita sem você perceber.
- **Fim dos seletores de modelos sem suporte para provedores compatíveis com OpenAI**: a página Acesso à API agora oculta a opção para provedores que não oferecem suporte a ela, em vez de deixar a configuração em um estado sem efeito.
- **Verificações e downloads de atualização usam a fonte selecionada**: ambos agora respeitam a fonte de download escolhida, garantindo que a verificação e o download não utilizem fontes diferentes.
- **Fluxo de salvamento do ZCode alinhado ao catálogo do Codex**: o salvamento e a persistência do catálogo do ZCode agora se comportam como no Codex, com a adição do nível de raciocínio ultra.

## Alterações

- **Ações mais limpas nos cartões de arquivos de autenticação**: as ações dos cartões ficam mais organizadas, com as exclusões de modelos agora gerenciadas centralmente na caixa de diálogo de configurações.
