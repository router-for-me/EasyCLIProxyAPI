- Se você tiver dúvidas ou sugestões sobre o software, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o quanto antes.

## Correções

- **O canal de prévia informava indevidamente “nenhum lançamento de prévia”**: a busca da prévia mais recente usava apenas a API do GitHub, então, quando a solicitação anônima batia no limite (60 por hora), concluía que não havia compilação de prévia, mesmo quando havia. Agora tenta de novo pelo feed do GitHub e só informa erro quando as duas fontes falham.
- **As verificações de atualização agora usam o token do GitHub configurado**: o Token global do GitHub nas configurações era usado só pela loja de plugins, enquanto as verificações de versão ainda saíam de forma anônima. As duas passam a compartilhar o mesmo token, elevando o limite de 60 para 6000 solicitações por hora. A solicitação anônima e o feed continuam em uso quando nenhum token está definido.
- **Verificações que falhavam permaneciam em “Detectando”**: quando a verificação de atualização do aplicativo falhava, o bloco Versão mais recente ficava em “Detectando” para sempre, contradizendo o selo “Falha na verificação” acima. Agora ele mostra o estado de falha.
- **A aba Uso de agentes perdia o estado ao ser reaberta**: voltar a Uso de agentes a partir de outra página mostrava “Aguardando o núcleo” na barra do topo, embora a coleta local ainda estivesse em andamento. O status do coletor agora é recarregado e mostra “Coletando localmente”.

## Novidades

- **Intervalos de datas personalizados para as estatísticas de uso**: o intervalo fixo “Últimas 24 horas” é substituído por “Personalizado”, que abre atalhos (ontem, esta semana e a semana passada, este mês e o mês passado, últimos 90 dias, este ano e o ano passado) além das datas de início e término, comparando com o período anterior de mesma duração.
- **O calendário de atividade se ajusta à largura disponível**: ele não desenha mais sempre um ano inteiro. Preenche o espaço e termina em hoje, rolando só quando o histórico é mais longo, e o mapa de calor por hora permanece na mesma linha sempre que couber.
- **O ano aparece nos rótulos que cruzam o ano**: o rótulo de janeiro do calendário e os rótulos do eixo de tendência agora incluem o ano.
- **A granularidade é mantida ao trocar o intervalo**: a granularidade escolhida (hora, dia, semana ou mês) sobrevive à mudança de intervalo e só volta para dia quando não há dados por hora (Todo o período, ou um intervalo personalizado mais antigo que o histórico por hora de 30 dias).

## Melhorias

- **Uma falha na consulta ao upstream não interrompe mais um lançamento**: a compilação consulta a versão mais recente do núcleo upstream e, antes, abortava a compilação daquela plataforma quando as três fontes falhavam. Agora ela mantém a versão fixada do núcleo e continua. Só uma verificação explícita de atualização ainda falha de forma definitiva.
- **Enviar a branch main não dispara mais uma compilação completa**: cada push em `main` compilava as seis plataformas só para aquecer os caches, gastando tempo dos executores. As compilações agora ocorrem apenas nas tags de lançamento, e os caches continuam sendo gravados para que as compilações seguintes ainda os aproveitem.
