- Se você tiver dúvidas ou sugestões sobre o software, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Novidades

- **Duas formas de medir a velocidade de saída**: a Visão geral de Uso e os detalhes das solicitações agora compartilham uma configuração de modo de velocidade, alternável entre “Sem TTFT (apenas a fase de geração)” e “Latência total (velocidade de ponta a ponta)”. Sem TTFT conta só a fase de geração, o que acompanha a velocidade com que o modelo de fato escreve. A latência total inclui a espera até o primeiro token, o que acompanha como a solicitação é percebida de ponta a ponta. O cartão de TPS da visão geral e a dica dele seguem o modo selecionado, e a escolha é lembrada entre sessões.
- **Importar capacidades de modelos de catálogos externos**: a configuração de agentes agora pode trazer metadados de capacidade de modelos de um catálogo externo, para que as opções compatíveis e os indicadores de capacidade acompanhem esse catálogo.

## Melhorias

- **Amostras de velocidade e elegibilidade**: respostas curtas não são mais descartadas dos números de velocidade: elas também informam um valor. Só ficam de fora registros com falha, cancelados, com saída vazia e sem tempo medido, e o modo padrão agora é o que subtrai a latência até o primeiro token.
- **Explicação do TPS na visão geral**: a dica agora descreve o cálculo e as condições da amostra do modo que estiver ativo, em chinês, inglês, japonês e russo.

## Correções

- **Limite de saída ausente nas regras manuais de modelo do zcode**: regras de modelo escritas à mão agora recebem o `maxOutputTokens` exigido, então salvar não produz mais chamadas que falham por falta desse campo.
- **Cantos grudados do cabeçalho da tabela de eventos**: removido o arredondamento sobrando, então o cabeçalho fixo não mostra mais cantos brancos partidos durante a rolagem.
- **A dica de TPS em russo não batia com a fórmula**: corrigida a descrição da base de cálculo em russo.
