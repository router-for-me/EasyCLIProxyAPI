Esta versão adiciona o interruptor “Ocultar desativadas” à visão de roteamento, para que uma lista longa de credenciais deixe de enterrar os níveis que de fato atendem ao tráfego, remove a barra de rolagem horizontal duplicada acima da tabela de uso e deixa de executar o fluxo completo de empacotamento para cada pull request externo.

Se encontrar problemas, avise no [Discord](https://discord.gg/your-discord-invite) ou abra uma issue no [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Novidades

- **Ocultar temporariamente as credenciais desativadas na escada de roteamento**: a página de roteamento agora tem o botão “Ocultar desativadas” na barra de ferramentas. Com ele ligado, as credenciais desativadas saem dos cartões de nível, e um nível cujos membros estão todos desativados é recolhido para fora da vista. A numeração dos níveis continua contínua, e arrastar e separar continuam funcionando. O interruptor é só de visualização: prioridades, pesos e o plano de roteamento não são alterados, e a escolha é lembrada entre sessões.

## Correções

- **Duas barras de rolagem horizontais nos detalhes das solicitações**: a tabela de uso desenhava uma segunda barra de rolagem por cima da nativa, na base. A barra de cima agora dimensiona a trilha para caber no conteúdo da tabela e se oculta quando nada transborda, então as duas não disputam mais a mesma posição de rolagem.

## Melhorias

- **As compilações de pull request ficam restritas aos mantenedores**: o fluxo de empacotamento agora só roda para pull requests de autoria dos mantenedores do repositório, então contribuições externas não entram mais na fila de uma compilação completa em várias plataformas, e os lançamentos formais recebem os executores mais cedo.
