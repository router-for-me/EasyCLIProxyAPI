- Se você tiver dúvidas ou sugestões sobre o software, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Correções

- **A descoberta de agentes consumia CPU em máquinas com muitos diretórios de ambiente**: ao iniciar e sondar os agentes, cada diretório em `.local/state/fnm_multishells` e `.nvm/versions/node` é visitado, e cada caminho recém-coletado era comparado com todos os caminhos já coletados. Com uma árvore grande acumulada do FNM (um relato tinha cerca de 199.000 entradas), o número de comparações cresce de forma quadrática e mantém a CPU ocupada mesmo sem solicitações de modelo em andamento (medido em 57%–62%). A deduplicação agora usa um conjunto de hash, preservando a ordem original dos caminhos e a grafia da primeira ocorrência.

## Melhorias

- **Os resultados da deduplicação não mudam**: duplicatas, barras finais, caminhos equivalentes que diferem apenas por `/./` e entradas vazias se comportam exatamente como antes, então a precedência da busca de executáveis não é afetada.
