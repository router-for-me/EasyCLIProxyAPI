- Se você tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Correções

- **O botão Aplicar plano não fica mais cinza em silêncio**: na página de roteamento, quando o plano falha na validação, o motivo aparece ao lado de “Aplicar plano”, em vez de deixar um botão desativado sem explicação.
- **Orientação do formato da duração da sessão**: informar uma duração de sessão sem unidade (por exemplo, `3`) agora destaca o campo e mostra “A duração da sessão deve incluir uma unidade, como 1h, 30m ou 1h30m.” O campo continua aceitando apenas durações com unidade; `1h`, `30m` e `1h30m` são aplicados normalmente.

## Melhorias

- **Descrições dos campos da política do gateway**: novas tentativas por solicitação, credenciais por tentativa, espera máxima entre tentativas, espera após erro temporário e o interruptor Desativar período de espera ganharam uma descrição de uma linha, em vez de um rótulo solto e uma caixa numérica.

## Novidades

- **Servidores MCP e skills de agente numa só página**: a nova página “MCP e skills” lista os servidores MCP e as skills de agente que o aplicativo enxerga, com um painel de detalhes para cada item.
  - Os servidores mostram o transporte (stdio, HTTP ou SSE), o comando ou a URL, os argumentos e o ambiente com que são executados e se estão ativados. É possível adicionar, editar, excluir, ativar ou desativar um servidor e importar ou exportar a lista inteira como JSON.
  - As skills são agrupadas pela origem (OpenClaw, o projeto, a Oficina ou um diretório personalizado), mostram a descrição, o caminho e a quantidade de arquivos e podem ser ligadas ou desligadas. Os arquivos de uma skill aparecem num painel de leitura.
  - Um filtro em chip em cada aba restringe a lista por transporte ou por origem, e a página continua funcionando até o mínimo de janela de 640px.
- **Proxy reverso integrado**: um serviço opcional de proxy reverso agora pode encerrar o TLS do serviço local do núcleo, configurável na página Acesso externo, com certificado e porta de escuta.
