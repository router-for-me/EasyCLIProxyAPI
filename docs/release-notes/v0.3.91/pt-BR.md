- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- **Atualizar o ECPA sem reiniciar o núcleo**: usuários de Windows e macOS agora podem desmarcar "Reiniciar também o núcleo" durante uma atualização do aplicativo para manter em execução o núcleo atual e os agentes conectados diretamente a ele. Reiniciar o núcleo continua sendo o padrão. O novo núcleo incluído fica adiado até uma atualização manual do núcleo. Conexões de proxy hospedadas pelo ECPA e o DeepSeek Harness gerenciado continuam sendo interrompidos quando a interface reinicia; no Linux, atualmente é obrigatório reiniciar o núcleo.

## Melhorias

- **Layout da página de plugins**: o estilo das abas das subpáginas foi unificado com o das demais páginas, e os controles de busca e ação das abas locais e da loja foram alinhados em janelas estreitas.
- **Carregamento do catálogo de modelos**: o ZCode agora carrega o catálogo externo de capacidades uma única vez por abertura do editor ou geração de configuração, em vez de relê-lo para cada modelo.

## Correções

- **Leituras excessivas em disco na configuração do ZCode**: removida a calibração automática de capacidades dos modelos a partir do histórico de solicitações. Abrir o editor de modelos ou gerar configurações não percorre mais repetidamente os registros históricos de uso para cada modelo. Os padrões de modelo, os dados do catálogo externo e as configurações manuais continuam disponíveis.
- **Configurações salvas do ZCode sobrescritas pelos padrões**: janelas de contexto salvas explicitamente e seleções vazias de níveis de raciocínio agora são preservadas em vez de serem substituídas por padrões inferidos.
