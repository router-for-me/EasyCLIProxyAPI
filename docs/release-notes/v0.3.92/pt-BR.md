- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Melhorias

- **Página Configurações de plugins**: removidas duas linhas de dica redundantes abaixo dos campos de fonte da loja e autenticação. Foi mantida a nota que explica que o catálogo de destaques do ECPA se cadastra automaticamente como fonte de plugins, pois indica uma fonte adicionada pelo próprio aplicativo.

## Correções

- **Lista de plugins em destaque congelada em um instantâneo antigo**: a página Destaques do ECPA não recorre mais a uma cópia do registro incluída no aplicativo. Uma falha de leitura agora exibe uma lista vazia com um erro explícito, em vez de mostrar silenciosamente plugins congelados no momento da compilação.
- **Plugins em destaque ausentes após a migração do registro para o esquema versão 2**: o analisador do registro rejeitava `schema_version` 2 de imediato, descartando downloads bem-sucedidos e relatando falha de leitura na página. Ambas as gerações de esquema agora são aceitas; versões desconhecidas continuam sendo rejeitadas.
- **Aviso de erro desatualizado após uma atualização bem-sucedida**: clicar em Atualizar agora limpa o aviso anterior de "Não foi possível ler a fonte de plugins", e uma atualização com falha limpa a lista antiga, evitando que a página exiba cartões ao lado de uma mensagem de erro.
- **URLs de proxy SOCKS rejeitadas nas configurações de rede**: `socks://`, `socks5://` e `socks5h://` agora são aceitos independentemente de maiúsculas ou minúsculas, com `socks://` normalizado para `socks5://`.
