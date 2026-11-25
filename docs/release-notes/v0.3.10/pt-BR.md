## Melhorias

- Adicionado suporte ao formato mais recente `.zcode/v2/provider_config.json` do ZCode. O aplicativo pode definir, detectar e restaurar a conexão de proxy e o modelo padrão, preservando as demais configurações de provedores.
- Atualizações do aplicativo e do núcleo agora são verificadas sempre que você acessa o Gerenciamento de versões. Volte à página para verificar novamente.
- Prioridades de provedores agora aceitam números inteiros negativos, com validação de intervalo antes de salvar.
- O TTL da afinidade de sessão é validado antes de salvar e aceita durações como `30m` e `1h30m`. Deixe em branco para usar o padrão; valores válidos abaixo de um segundo são salvos como um segundo.
- Erros da API de gerenciamento do núcleo v8 agora mostram o tipo de erro e o motivo detalhado, facilitando a identificação de configurações inválidas.

## Correções

- Corrigida a interrupção de atualizações no macOS quando um DMG estava temporariamente ocupado e não podia ser desmontado. A desmontagem é tentada novamente e a limpeza é adiada quando necessário.
- Corrigida a perda ocasional de nomes de grupos de provedores e observações no núcleo v8 após leitura ou salvamento. A detecção de duplicatas não depende mais dos nomes dos grupos.
- Corrigida a rejeição de credenciais do DeepSeek pelo núcleo ao salvar quando nomes de grupos eram gravados nos campos errados.
- Corrigida a sobrescrita das configurações de raciocínio de modelos ao editar um provedor. As configurações existentes de cada modelo são preservadas quando os níveis de raciocínio não são alterados, enquanto limpá-las manualmente não restaura mais valores antigos.
- Adicionada compatibilidade com campos de raciocínio nos resultados de descoberta de modelos e removido o item de configuração legado “Modelo de teste”.
- Corrigido o salvamento incorreto das opções “Desativar intervalo de espera” e de cache do ID de usuário do Claude quando desativadas. Agora é possível escolher explicitamente o estado padrão, ativado ou desativado.
- Corrigidos nós vazios e campos antigos misturados com novos em configurações do núcleo v8 que faziam TLS, palavras sensíveis e outras configurações serem lidas ou gravadas incorretamente.
- Corrigidos os valores padrão exibidos para endereço de escuta, estatísticas de uso, número de novas tentativas e intervalo de novas tentativas para refletir o comportamento do núcleo quando essas opções são omitidas.
- Corrigidas as caixas de diálogo de edição de provedores de API e seleção de modelos que ultrapassavam a tela e não rolavam corretamente em janelas estreitas ou no WebKit do macOS.
