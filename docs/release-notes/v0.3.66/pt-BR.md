- Se você tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Novidades

- **Aba própria de “Roteamento ao vivo” em Uso**: o Roteamento ao vivo saiu da Visão geral e passou a ter a própria aba, mantendo no topo a barra de resumo com 6 itens (total de requisições, TPS, total de tokens, taxa de sucesso, taxa de acerto do cache e custo estimado). A visão de topologia em três colunas abaixo (“Modelos → Gateway → Serviços de origem”) mostra os caminhos das solicitações, a latência média, as contagens de falha e os temporizadores de período de espera das credenciais numa janela móvel de 60 segundos, e a aba Visão geral volta a exibir os dois gráficos lado a lado.
- **Atualização do layout do uso de agentes**: a barra de resumo do topo passou a um único cartão dividido em 6 colunas. A lista de fontes de agentes virou uma grade horizontal de cartões em 4 colunas, com ícones de marca dos clientes, percentuais de participação em tokens e detalhamento de custo. O detalhamento diário e as tabelas de preços dos agentes ficam lado a lado no desktop.

## Correções

- **Menu suspenso da versão do núcleo estourando em Gerenciamento de versões**: os elementos `<select>` nativos de Selecionar versão do núcleo e da fonte de download foram substituídos por menus suspensos personalizados, com altura limitada a `280px` e rolagem interna, para que listas longas de versões não cubram a tela. Os botões de ação dos cartões Aplicativo de desktop e Núcleo do proxy foram alinhados.
