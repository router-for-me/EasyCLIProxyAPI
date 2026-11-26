- Se você tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Correções

- **Fim da caixa vazia de crédito de redefinição nos cartões de cota**: quando uma conta não tem saldo de créditos nem créditos de redefinição aplicáveis, o cartão não mostra mais uma caixa vazia na base. Uma consulta de crédito de redefinição que falha passa a ser informada abaixo do cartão, e não dentro dele.
- **O cartão de cota acompanha o tema**: a área de crédito de redefinição agora usa a superfície suave do tema, em vez de uma superfície escura fixa, e não aparece mais como um bloco escuro nos temas claros.
- **Nomes de limite de cota consistentes**: todo provedor nomeia os limites com a mesma redação — “Limite de 5 horas”, “Limite semanal”, “Limite semanal do Opus” e assim por diante — em vez de misturar “janela” e “cota”. Inglês, chinês simplificado, chinês tradicional e japonês foram atualizados juntos.
- **Os painéis de uso não preenchem mais a janela**: os painéis Estatísticas de preços e Gerenciamento de dados agora terminam com o conteúdo, em vez de se esticarem até a base da janela. Uma lista longa de preços continua rolando dentro do painel.
- **A página atual permanece visível na navegação superior estreita**: quando a janela fica estreita o bastante para a navegação virar uma linha no topo, uma página aberta por um botão de outra página passa a rolar o próprio item de navegação até a vista. A barra lateral das janelas largas permanece como está.

## Novidades

- Testes automatizados de interface agora cobrem a rolagem da navegação superior até o item atual e as alturas dos painéis de uso, de janelas de 640px a 1920px.
