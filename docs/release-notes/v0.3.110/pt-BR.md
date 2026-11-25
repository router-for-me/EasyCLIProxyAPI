Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- **Ciclo completo de ferramentas no ACP**: ferramentas de função agora são expostas à CLI oficial por meio de um adaptador MCP autenticado integrado, permitindo que clientes Chat Completions e Responses recebam `tool_calls`, executem-nas e devolvam os resultados para a mesma execução. Há suporte a streaming, chamadas pendentes mantêm seu processo da CLI e expiram após dez minutos, e um ID de ferramenta já concluído não pode ser entregue duas vezes. Não é necessário instalar nenhum MCP do lado do usuário.

## Melhorias

- **Compatibilidade com clientes ACP**: `tools` vazio ou nulo, `tool_choice` auto sem ferramentas e `tool_choice: none` explícito são aceitos. Campos comuns de clientes — `n: 1`, `store: false`, `response_format` em texto, `parallel_tool_calls`, `user`, `metadata`, `prompt_cache_key` e `safety_identifier` — são validados e aceitos. `max_tokens`, `max_completion_tokens`, `temperature` e `top_p` são aceitos por compatibilidade, e os valores que a CLI não consegue aplicar são listados no cabeçalho de resposta `x-ecpa-ignored-parameters` em vez de rejeitar a solicitação.
- **Instruções de sistema no ACP**: instruções de sistema e de desenvolvedor agora são entregues separadamente pelo recurso anunciado de adição ao prompt de sistema da CLI ou pela extensão oficial do Antigravity, preservando os padrões do próprio agente em vez de incorporá-las ao turno do usuário. Uma CLI sem nenhum desses dois recursos retorna um erro claro informando que é necessário atualizar quando há instruções presentes.
- **Ativação e desativação da API do ACP**: o cartão da API agora usa um seletor explícito de ligar/desligar com estados distintos para desativada, iniciando, ativada aguardando conexão e ativada. Desativar continua disponível sempre que o acesso estiver ligado, mesmo com a conta desconectada ou sem modelos; ativar exige uma conta conectada e explica o pré-requisito ausente no próprio cartão. Erros aparecem no cartão e o seletor volta a um estado operável.

## Correções

- **O acesso à API do ACP não podia ser desativado de forma confiável**: o acesso agora vem desativado por padrão, e fazer login, atualizar, trocar de conta ou reiniciar o aplicativo não faz mais parecer que ele foi ativado. Desativar grava a intenção de desligamento de forma atômica, limpa sessões pendentes de ferramentas e o serviço de escuta e remove o provedor gerenciado tanto do formato de configuração legado quanto do v8. A operação é idempotente e falha de forma segura (fail-closed), de modo que um erro de limpeza não pode deixar um acesso residual que volte a ficar ativo na próxima inicialização.
