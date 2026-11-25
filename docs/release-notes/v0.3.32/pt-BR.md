- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [Discord](https://discord.gg/PxvX4D9kgs) ou envie pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- Quando a lista de palavras sensíveis do prompt de sistema do Antigravity estiver vazia em Modelos e requisições, abrir ou atualizar a página preenche previamente `Claude`, `GPT-5`, `GPT-6`, `Codex` e `Anthropic`. Clique em Salvar para aplicá-las; listas existentes não vazias são preservadas.
- Adicionado um botão de copiar para os detalhes de erro das solicitações, disponível tanto na visualização recolhida quanto na expandida, para facilitar a solução de problemas e o envio de relatos.

## Melhorias

- Agrupadas as configurações avançadas de provedores de API em regras de modelos, conexão e roteamento, e comportamento de solicitações para facilitar a navegação.
- Simplificados os filtros de uso para período, modelo, origem, API Key e resultado. A tabela padrão de solicitações agora exibe informações da chave da solicitação, dando preferência à sua observação quando disponível.
- As inicializações automáticas de CLI no Windows agora usam uma sessão persistente do PowerShell para o Claude Code e outros clientes, preservando o diretório de trabalho e as configurações de ambiente para melhorar a compatibilidade de terminal em comparação com inicializações diretas ([#393](https://github.com/router-for-me/EasyCLIProxyAPI/issues/393)).

## Correções

- Corrigidos os menus suspensos de filtros de uso que ficavam desalinhados ou cortados pelos contêineres da página e menus longos que voltavam ao topo após rolar. A posição de rolagem dos menus é preservada ao redimensionar a janela ou rolar um contêiner pai ([#396](https://github.com/router-for-me/EasyCLIProxyAPI/issues/396)).
- Corrigido o TPS da visão geral para usar a média aritmética das velocidades válidas de geração por solicitação.
- Corrigida a resolução incompleta de observações de origem de credenciais e provedores de API, e separados os rótulos de chave da solicitação das origens de destino para evitar misturar suas observações.
- Corrigido o problema em que as listas de filtros não atualizavam após adicionar chaves ou alterar observações. Atualizações manuais e periódicas agora atualizam as opções preservando a chave selecionada.
- Corrigido o problema em que o Oh My Pi dependia apenas de uma variável de ambiente no momento da inicialização para sua API Key. A chave agora é salva em `models.yml`, permitindo que inicializações manuais pelo terminal também usem a chave configurada.
