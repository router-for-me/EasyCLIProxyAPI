- Se você tiver dúvidas ou sugestões sobre o software, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Novidades

- **Servidores MCP e skills podem sincronizar com o OpenClaw**: as entradas de servidor MCP e de skill de agente agora podem ser gravadas na configuração do OpenClaw, sem precisar copiar à mão.
- **Ordem personalizada dos modelos do Codex**: a lista de modelos pode ser reordenada, e a ordem é salva e restaurada na próxima abertura.
- **Tags de credenciais em lote**: defina, limpe ou mantenha tags em várias credenciais de uma vez, preservando as tags existentes e deixando de fora da seleção as entradas que não podem ser editadas.
- **Consulta de cota do z.ai Coding Plan**: veja a cota do z.ai Coding Plan, inclusive as janelas semanal e de equipe.
- **Roteamento semântico de modelos, opcional**: escolha um serviço de origem pela semântica do modelo. A opção vem desativada e o caminho de roteamento é verificado antes de ser ativado.
- **Confirmação antes de aplicar um plano de roteamento**: aplicar um plano agora abre um diálogo de confirmação que lista cada alteração que será gravada.
- **Argumentos personalizados de inicialização da CLI**: há suporte a argumentos extras de inicialização do núcleo, e a política de execução de scripts é preservada.
- **Lançamentos de prévia usam tags com carimbo de data e hora**: cada compilação de prévia publica o próprio lançamento com carimbo de data e hora, mantém os oito mais recentes, e o cliente escolhe automaticamente o mais novo. As descrições do canal de download agora separam os destinos de prévia e estável.
- **Opções do núcleo v8 que faltavam**: o Gerenciamento de configuração passa a expor as opções do núcleo que antes não apareciam, agrupadas por finalidade.

## Correções

- **Layout quebrado no diálogo de servidor MCP**: o corpo do formulário era espremido numa faixa fina, com os campos de nome e comando escondidos atrás de uma barra de rolagem minúscula e os botões do rodapé esticados. O formulário agora tem a altura normal e todos os campos ficam visíveis de uma vez.
- **Estado do proxy reverso perdido ao reiniciar**: desligar o proxy reverso e reiniciar fazia o interruptor voltar para ativado. O estado agora é salvo e restaurado, e o marcador de reinício necessário não é mais apagado por gravações posteriores.
- **Páginas embutidas em branco depois que o WebView principal encerrou**: os WebViews principal e filhos agora se recuperam, e um status desconhecido do núcleo não os limpa mais.
- **Contabilização de uso do Copilot**: comentários da configuração da CLI e JSON que não pode ser interpretado deixam de ser tratados como erros, e sessões encerradas não são contadas duas vezes.
- **Exibição de crédito na nuvem do Claude**: o saldo na nuvem fica separado das demais cifras de crédito, em vez de aparecer misturado.
- **Estatísticas de tokens por chave**: a visão de tokens por chave foi restaurada.
- **URLs de contingência do GitCode**: um GitCode não configurado não recebe mais solicitações de contingência (Refs #548).
- **Certificados raiz corporativos**: o #408 agora confia nas raízes corporativas nativas do sistema.
- **Falhas de validação do roteamento**: um plano de roteamento rejeitado agora mostra o motivo da falha, em vez de recorrer a uma alternativa em silêncio.
- **Ordem dos idiomas das notas de versão**: as notas agora são publicadas na ordem en, zh-CN, zh-TW, ja.

## Melhorias

- **Páginas de MCP e skills**: uma falha de carregamento mostra uma faixa de erro no próprio lugar e um estado vazio, em vez de uma página em branco, e o espaçamento e o layout da lista foram ajustados.
- **Cartão de configurações do proxy reverso**: organizado como um resumo da rota de acesso mais o status de proteção, com agrupamento mais claro.
