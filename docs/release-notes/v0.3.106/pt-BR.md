- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Melhorias

- **Confiabilidade no empacotamento de versões**: a criação de imagens DMG no macOS tenta novamente em caso de falha e desmonta apenas o próprio volume, as compilações Intel macOS são executadas em runners Apple Silicon, o Linux faz a vinculação com mold e os downloads de ativos de lançamento tentam novamente quando um ativo ainda não foi enviado em vez de falhar a compilação.

## Correções

- **Folha de estilos da Loja de plugins**: as regras após o bloco do logotipo do plugin não saem mais da camada de componentes, mantendo o espaçamento da barra de resultados da Loja de plugins e permitindo que a folha de estilos seja interpretada sem erro de sintaxe.
