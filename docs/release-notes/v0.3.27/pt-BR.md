## Notas da versão v0.3.27

- Sugestões e relatos de problemas são bem-vindos no chat da comunidade ou no GitHub.
- Esta versão adiciona suporte ao Oh My Pi, aprimora consideravelmente a configuração do Claude Code e torna mais confiável o comportamento das cotas e da interface desktop.

## Novidades

- Adicionado o Oh My Pi como cliente de agente gerenciado pela API OpenAI Responses. O CPA descobre automaticamente os modelos disponíveis, aplica as configurações gerenciadas de provedor e modelo e faz backup e restauração da configuração original do Oh My Pi.
- Adicionadas preferências persistentes de tema no desktop para os modos Claro, Escuro e Automático.

## Melhorias

- As configurações de modelo do Claude Code agora seguem a estrutura de modelos do Claude Code, com modelos independentes de inicialização e de subagente, mapeamentos de modelos por função e opções de contexto de 1M.
- As configurações de execução do Claude Code são salvas corretamente e a configuração gerenciada é removida com segurança ao desativar o gerenciamento ou restaurar o estado anterior.
- O relatório de cotas do Grok agora mantém o uso semanal e mensal alinhados, identifica os planos de assinatura com mais precisão e exibe saldos pré-pagos quando disponíveis.
- As linhas de solicitações de uso agora se ajustam ao conteúdo. Os cartões de credenciais e os controles de ação ficaram mais compactos e evitam sobreposição de conteúdo.
- Atualizado o núcleo CLIProxyAPI incluído para a versão **8.0.20**.

## Correções

- Corrigidos os seletores de modelo do Claude Code e os painéis de cota das credenciais que podiam se sobrepor ou exibir informações incompletas.
- Corrigido o enriquecimento do cache de cotas do Grok para que detalhes da assinatura não sobrescrevam resultados de cota mais recentes.
- Os botões de ação das credenciais agora usam estilo neutro para dar um retorno visual de status mais claro.
