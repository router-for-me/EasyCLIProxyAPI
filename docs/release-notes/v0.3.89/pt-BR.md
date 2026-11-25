- Se você tiver dúvidas ou sugestões sobre o software, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Novidades

- **Ativar ou desativar modelos a partir do diálogo de verificação de funcionamento**: cada linha de modelo no diálogo de verificação de funcionamento dos modelos agora tem o próprio interruptor, então não é mais preciso abrir o diálogo de edição para mudar a lista de exclusão. O interruptor grava de volta na configuração `excluded-models` já existente desse provedor, adicionando ou removendo apenas a regra exata deste modelo e mantendo intactas as exclusões por curinga de todo o provedor e quaisquer regras escritas à mão.
- **Modelos desativados ficam visíveis de relance**: a linha de um modelo desativado ganha um fundo atenuado, e o nome do modelo e a pílula de resultado esmaecem juntos, então o conjunto disponível no momento fica evidente.

## Melhorias

- **Lista da verificação de funcionamento em larguras estreitas**: as linhas de modelo se empilham na vertical em janelas estreitas, dispondo nome, interruptor, resultado e botão de ação em ordem, em vez de espremer a pílula de resultado.
- **Quebra do texto de aviso**: o texto explicativo agora quebra apenas na pontuação, então palavras em chinês não são mais partidas entre linhas.

## Correções

- **O interruptor volta atrás quando o salvamento falha**: se a alternância de um modelo não puder ser salva, o interruptor retorna ao estado anterior e informa o erro, em vez de mostrar um estado que não corresponde à configuração salva.
