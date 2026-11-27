- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Novidades

- Seleção e persistência independentes da API Key de autenticação do agente: é possível escolher uma API Key de autenticação individual para cada configuração de agente, com retorno automático à API Key padrão efetiva e tradução em todos os idiomas ([#544](https://github.com/router-for-me/EasyCLIProxyAPI/pull/544), [#545](https://github.com/router-for-me/EasyCLIProxyAPI/pull/545)).
- Catálogo de modelos e configuração de subagentes do ZCode: adicionado um diálogo de seleção do catálogo de modelos e um painel de configurações de subagentes do ZCode, com vários níveis de raciocínio e a especificação da janela de contexto Spark 1M.

## Correções

- Correção da inicialização de CLIs no Windows: corrigida a falha ou o travamento ao iniciar shims de CLI instalados globalmente pelo npm no Windows.
- Correção de correspondência de aliases e roteamento do Claude Desktop: corrigida a falha do cliente em voltar ao modelo principal quando aliases de provedores específicos estavam desativados ou filtrados.
- Persistência da configuração do ZCode e conformidade com o schema: `maxOutputTokens` passa a seguir estritamente o schema de objeto do Zod, e foram resolvidos problemas de seleção no catálogo, herança do limite de Tokens, conflitos de empréstimo e sincronização de estado ao salvar as configurações.
- Ajustes de layout e interação da interface: otimizado o layout do diálogo de subagentes do ZCode, refinada a rolagem da barra lateral e o diálogo do catálogo de modelos fecha automaticamente depois de salvar.
