## Novidades

- Adicionados os modelos de configuração oficiais GPT-6 Sol e GPT-6 Luna à configuração de modelos do Codex na Configuração de agentes.
- Adicionada a página Palavras sensíveis em Configurações avançadas para editar separadamente os termos de prompt de sistema do Antigravity e do Devin. É possível adicionar, editar ou remover itens individualmente, ou colar várias linhas de uma vez.

## Melhorias

- Atualizado o script de compilação para Windows para detectar e atualizar caches de compilação do Tauri desatualizados após mover a pasta do projeto. Use `-SkipCopy` para compilar sem sobrescrever um aplicativo portátil em execução.
- Ajustada a contagem regressiva de redefinição de cota para exibir dias, horas e minutos restantes sem arredondar para cima.

## Correções

- Corrigido o problema em que registros de uso antigos permaneciam no topo da lista quando vários eventos de uma mesma solicitação compartilhavam o mesmo ID de solicitação (#298).
