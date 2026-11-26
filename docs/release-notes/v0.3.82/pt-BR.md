Esta versão corrige a parte mais sujeita a falha da inicialização: o núcleo não é mais julgado por um cronômetro fixo. Antes, o aplicativo dava 10 segundos à porta de gerenciamento depois da abertura, então máquinas com muitos plugins eram informadas como falha de início antes de terminarem de carregar, e atualizar o núcleo podia até reverter uma versão nova saudável como “falha ao iniciar”. O aplicativo agora continua esperando enquanto o processo do núcleo estiver vivo e informa a prontidão por conta própria. Um processo que encerrou, o desligamento do aplicativo ou uma porta de gerenciamento em escuta são os únicos três desfechos. Os detalhes das solicitações também ganham uma escolha de como a velocidade de saída é calculada, entre a vazão de ponta a ponta e o tempo puro de geração, com a latência até o primeiro token removida.

Se encontrar problemas, avise no [Discord](https://discord.gg/your-discord-invite) ou abra uma issue no [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Correções

- **A inicialização do núcleo não é mais cortada por um tempo limite fixo**: a espera de prontidão estava fixada em 10 segundos, então máquinas com vários plugins e uma primeira carga lenta viam uma falha de início. A espera agora termina apenas quando o processo do núcleo encerra, o aplicativo está desligando ou a porta de gerenciamento aceita conexões. Um processo vivo simplesmente continua sendo aguardado, e inícios lentos não são mais informados por engano como falhas.
- **Atualizar o núcleo não reverte mais num início lento**: atualizações e o botão de iniciar em Início compartilham um único caminho de inicialização, em que uma partida lenta aparecia antes como “a nova versão falhou ao iniciar” e restaurava a anterior. Um início lento agora só demora mais, em vez de reverter uma instalação que já estava no lugar.

## Novidades

- **Os detalhes das solicitações podem alternar como a velocidade é calculada**: os tokens por segundo agora podem ser medidos pelo tempo total decorrido (Latência total, velocidade de ponta a ponta) ou com a latência até o primeiro token removida (Sem TTFT, apenas a fase de geração), na configuração de exibição, com a lista recalculando na hora.
