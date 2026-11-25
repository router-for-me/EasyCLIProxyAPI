Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- **Atualizações automáticas em Gerenciamento de versões**: o aplicativo e o núcleo agora podem se atualizar sozinhos, sem download manual. Escolha quais itens acompanhar, e novas versões são baixadas silenciosamente enquanto o aplicativo está em execução e instaladas na próxima inicialização, antes de os serviços locais iniciarem. O recurso vem desativado por padrão, e atualizações manuais e automáticas nunca ocorrem ao mesmo tempo. Alterar a fonte de download, o canal ou o proxy descarta o download na fila, e uma versão que falhou ao instalar permanece bloqueada até você limpar a falha, em vez de tentar indefinidamente. Consulte [atualizações automáticas](docs/automatic-updates.md).

## Melhorias

- **Gerenciamento de versões mais compacto**: a página aproveita melhor a largura disponível e usa espaçamento mais enxuto, fazendo as configurações de atualização e os dois cartões de versão caberem sem linhas vazias altas que empurravam as ações para fora da tela.

## Correções

- **O uso de executores de plugins era precificado incorretamente**: registros de executores de plugins recorriam à convenção de tokens da OpenAI, mas esses executores seguem a convenção do protocolo de origem. Uma solicitação do Claude apenas com gravação em cache relatava 100% de taxa de acerto do cache, cobrava entrada sem cache como zero e cobrava gravações em cache duas vezes, enquanto os tokens de raciocínio do Gemini eram descartados da saída e ficavam sem cobrança. Os registros agora leem o `token_breakdown` independente de protocolo que o núcleo já fornece.
- **O salvamento de aliases falhava em configurações com uma seção final**: o editor YAML rejeita um documento seguido por elementos que não consegue anexar, fazendo com que uma configuração cujo próprio leitor para no fim do documento falhasse em todo salvamento de alias com "Content after the document could not be parsed". A parte final agora é separada, editada à parte e anexada novamente byte a byte.
- **Atualizações do núcleo falhavam quando o binário do núcleo era somente leitura**: a cópia reproduzia as permissões de origem, de modo que sobrescrever um núcleo `0555` gerava um arquivo temporário somente leitura e a gravação seguinte falhava com `EACCES`. O arquivo temporário agora é sincronizado por um identificador somente leitura no Unix, o identificador aberto para escrita é mantido no Windows, e a permissão de escrita do proprietário é restaurada para que atualizações futuras continuem substituíveis.
- **Uma configuração de atualização automática incompleta podia desativar o recurso silenciosamente**: uma configuração com atualização ativada, mas sem nenhum item selecionado, era substituída por inteiro pelos padrões durante a sanitização, e a configuração sanitizada era gravada de volta, tornando a redefinição permanente. Agora apenas a parte inalcançável é ajustada, o restante do registro é preservado e o recarregamento não grava nada quando o registro já está coerente.
- **A substituição da palavra `codex` usava maiúsculas/minúsculas incorretas**.
