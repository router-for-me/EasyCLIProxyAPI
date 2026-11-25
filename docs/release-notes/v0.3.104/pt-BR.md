- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- **Regras de substituição de palavras sensíveis**: uma nova página Palavras sensíveis permite gerenciar, por provedor, substituições de texto original, palavras de ofuscação e filtros de linha do prompt de sistema. Ao salvar, as regras são gravadas na configuração do núcleo e entram em vigor imediatamente.
- **Importação de regras na nuvem com um clique**: busca o arquivo oficial de regras no repositório do GitHub e adiciona apenas as entradas ausentes localmente; clicar novamente não gera duplicatas.

## Melhorias

- **Mesclagem de regras da nuvem**: a importação preserva suas edições não salvas e salva automaticamente o resultado mesclado. Se o download falhar ou o arquivo for inválido, a configuração existente permanece intacta; se o salvamento falhar, o conteúdo mesclado é mantido com um aviso de erro para que você possa tentar novamente.
- **Documentação do arquivo de regras**: adicionada uma referência de formato cobrindo os campos por provedor, limites de entradas e como manter o arquivo localmente.

## Correções

- **Autenticação com Token do GitHub**: os downloads de regras da nuvem reutilizam o Token de acesso do GitHub nas configurações, usam a variável de ambiente `GITHUB_TOKEN` como alternativa quando ele estiver vazio e respeitam as configurações de proxy do aplicativo.
- **Escopo de envio do Token**: o Token é enviado apenas para a API do GitHub e nunca para downloads públicos Raw ou destinos de redirecionamento; o arquivo público é usado apenas como alternativa quando a solicitação à API falha.
