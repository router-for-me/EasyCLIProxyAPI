## Novidades

- Conecte-se a um servidor CLIProxyAPI v8 externo pelo seletor CPA na barra lateral e gerencie as chaves de API dos clientes em uma área de trabalho separada, no modo Remoto. Há suporte a HTTP, HTTPS e prefixos de caminho de proxy reverso. O salvamento condicional evita sobrescrever alterações simultâneas. Para alternar entre o CPA integrado e o remoto, encerre o ECPA por completo e abra-o novamente.

## Melhorias

- O login em contas ACP agora usa perfis de CLI isolados. É possível adicionar e autorizar contas novamente sem substituir as demais contas salvas. Também é possível concluir a autorização manualmente por link. O aplicativo lida de forma mais confiável com caminhos e inicializadores de CLI no Windows. Verificações de recursos que falharem podem ser repetidas, e as mensagens de autorização diferenciam tempo limite, resposta rejeitada, link ausente e falha de rede.
- As versões estáveis e de prévia são comparadas de forma independente. Clique no logotipo do aplicativo para alternar a referência exibida em Gerenciamento de versões sem mudar o pacote instalado nem o canal de atualizações em segundo plano. As atualizações automáticas permanecem na mesma série de lançamentos do pacote instalado.
- A seleção de modelos de provedores agora exibe contagens corretas e preserva os modelos configurados que não vierem na lista do provedor, sinalizando-os em vez de omiti-los sem aviso.
- Os cartões de credenciais mantêm as ações mais usadas visíveis e agrupam as demais no menu Mais, acessível pelo teclado. Os temas claro e escuro integrados agora têm descrições, e o seletor CPA acompanha a paleta da barra lateral.

## Correções

- Manifestos de atualização válidos com uma única arquitetura passaram a ser aceitos, sem deixar de validar cada pacote listado. Isso permite um canal de prévia exclusivo para Windows x64. Os pacotes estáveis continuam disponíveis para Windows, macOS e Linux em x64 e ARM64.
