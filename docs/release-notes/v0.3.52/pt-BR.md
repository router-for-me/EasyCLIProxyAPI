- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Melhorias

- Atualizada a configuração de gateway para versões mais recentes do Claude Desktop. O CPA agora usa explicitamente credenciais estáticas e uma lista de modelos especificada, para impedir que a autenticação antiga, a configuração automática ou as configurações do serviço de sessão substituam a conexão do CPA.
- Atualizar a configuração do Claude Desktop agora muda corretamente para o perfil local do CPA. Restaurar um backup também restaura a seleção de configuração anterior.
- Adicionado o reconhecimento das famílias de modelos Fable e Mythos na configuração do Claude Desktop.
- Adicionadas as configurações de subagentes do Codex para ativar subagentes, limitar as conversas simultâneas, escolher um modelo padrão de subagente, definir o esforço de raciocínio e incluir mensagens de interrupção.
- Os modelos padrão de subagente agora podem ser escolhidos na lista de modelos do Codex, com o esforço de raciocínio herdado do agente principal ou selecionado de forma explícita.
- `enable-apply-patch` e `optimize-multi-agent-v2` agora ficam ativados por padrão quando não há valor definido, e as desativações explícitas do usuário são preservadas.
- Melhorados o layout da página de configuração do Codex e o diálogo de configurações de subagentes.

## Correções

- Corrigido o tratamento incompleto de aliases de modelos do Claude Desktop para provedores de API Key da xAI, da Meta, do Vertex e da Interactions. Modelos de API Key não são mais mapeados incorretamente para canais OAuth, o que podia torná-los indisponíveis.
- Corrigida a remoção de aliases ainda em uso ao salvar a configuração de novo. Rotas válidas já existentes são preservadas quando vários provedores oferecem o mesmo ID de modelo, evitando mudanças de provedor não intencionais.
- Corrigida a aceitação incorreta de modelos de API Key desativados ou excluídos por meio de mapeamentos OAuth desatualizados.
- Melhoradas as verificações da configuração do Claude Desktop para detectar conflitos de autenticação e de origem da configuração, além de listas de modelos incompletas.
- Melhoradas a proteção das credenciais e a reversão ao salvar mapeamentos de modelos, preservando as chaves do provedor e as configurações de conexão.

## Fluxo de lançamento

- Restauradas a compilação e a publicação automáticas da prévia Miaomiao. PRs que não são rascunho, de autoria de Roomen e com destino `miaomiao`, são mesclados automaticamente depois que as compilações das seis plataformas passam. O commit mesclado é então compilado e a prévia contínua é atualizada.

## Notas de uso

- Depois de atualizar, salve novamente a configuração do Claude Desktop no CPA e, em seguida, encerre o Claude Desktop por completo e abra-o de novo.
- Os aliases de modelos precisam apontar para um modelo de origem disponível. Se o modelo de origem estiver desativado ou excluído, ajuste a configuração de acesso ou selecione outro modelo disponível.
