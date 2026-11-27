- Se você tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Novidades

- **Detecção automática do ambiente WSL e alternância em um clique**: a seção de diretório de configuração em Configuração de agentes → Gerenciamento de configuração foi refeita, com um seletor segmentado entre Windows (local) e Subsistema WSL. No Windows, as distribuições WSL instaladas e os diretórios de usuário do Linux são varridos automaticamente, de modo que escolher uma distribuição e um usuário aplica na hora o caminho de configuração `\\wsl.localhost\<Distro>\home\<user>\...` correspondente, sem digitar o caminho UNC à mão. A seção expansível de caminho personalizado continua disponível para substituições avançadas.
- **Escada de níveis da orquestração do roteamento por fluxo e barra lateral da política do gateway**: a página Orquestração do roteamento foi refeita como uma área de trabalho de duas colunas, com uma escada vertical de níveis no fluxo das solicitações e uma barra lateral fixa da política do gateway. Mostra os estados de atendimento, em espera e nível pulado, junto com a parcela de tráfego de cada credencial, ícones de marca dos provedores, criação de nível ao soltar no intervalo, botões rápidos para subir ou separar o nível com os atalhos `Alt + ↑/↓` e marcadores de peso (`×1`) exibidos apenas no revezamento ponderado.

## Correções

- **Substituição explícita de prefixo vazio da chave na orquestração do roteamento**: corrigido o caso em que uma chave de provedor que limpava explicitamente o prefixo herdado do grupo (`prefix: ""`) ainda voltava a exibir o prefixo do grupo nos cartões de roteamento.
