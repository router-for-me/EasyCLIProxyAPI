- Se você tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Correções

- **Falsas falhas de leitura do uso de agentes**: corrigida a faixa de aviso persistente no topo da página Uso de agentes (por exemplo, `Copilot CLI: Não foi possível ler os registros locais de uso`). A varredura do Copilot percorria o diretório inteiro do Copilot e tentava interpretar arquivos de configuração sem relação, de modo que um único arquivo ilegível marcava a origem inteira como falha. Agora ela lê apenas o diretório de estado de sessão do Copilot, e arquivos históricos ilegíveis deixam de ser tratados como erros de sincronização: a origem volta ao status ocioso em vez de erro, e a faixa deixa de aparecer.
