- Se tiver dúvidas ou sugestões sobre o software, fale conosco no [Discord](https://discord.gg/PxvX4D9kgs) ou envie-as pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Vamos atendê-las o mais rápido possível.

## Novidades

- Adicionadas entradas na barra lateral para as páginas fornecidas pelos plugins ativados. Abra-as diretamente no aplicativo, com controles para voltar, recarregar ou abrir no navegador.

## Melhorias

- Ao atualizar a loja de plugins, as versões mais recentes dos repositórios públicos do GitHub são consultadas diretamente, reduzindo atrasos causados por informações de versão em cache.
- A configuração do VS Code Copilot agora inclui todos os modelos disponíveis, com janelas de contexto e entrada de imagem definidas conforme a capacidade de cada modelo. A entrada de imagem fica ativada por padrão quando faltam informações de modalidade de entrada.
- Melhorada a detecção de capacidades dos modelos para reconhecer mais campos de modalidade de entrada e de limite de saída, e para propagar as modalidades de entrada e o número máximo de Tokens de saída para a configuração do OpenClaw.

## Correções

- Corrigida a falha de núcleos assinados no macOS ao carregar plugins nativos.
- Corrigida a possível perda dos níveis de velocidade nas atualizações do catálogo de modelos do Codex e a demora para que alterações nos arquivos do catálogo passem a valer.
- Corrigidos estilos inconsistentes de botões, campos e menus suspensos em alguns temas, e menus suspensos abertos que não atualizavam ao trocar de tema.
- Corrigida a falha na exibição do número da versão do aplicativo na interface.
- Corrigido o aviso de reinicialização do Codex CLI que permanecia ou sumia ao navegar entre páginas.
- Reforçada a validação de links simbólicos ao gravar a configuração do cliente, para impedir que links de configuração aninhados apontem para diretórios raiz da estrutura.

## Atualizações anteriores selecionadas

## Novidades

- Adicionados os temas Areia quente, Grafite, Azul meia-noite e Rosa Sakura. Escolha temas claro e escuro separadamente e alterne entre eles automaticamente com a aparência do sistema.
- Adicionados os detalhes do limite individual de gastos das contas Codex Business, incluindo créditos usados e totais, percentual restante e horário de redefinição.
- Adicionado suporte para reiniciar o app-server do Codex CLI.
- Adicionado suporte à configuração do VS Code Copilot.
- Adicionada a funcionalidade experimental de edição de contexto.

## Melhorias

- Simplificados o fundo, a borda e os ícones do botão Aparência da barra lateral, para combinar melhor com os controles ao redor.
- As atualizações do núcleo agora concluem o download e a extração antes de interromper o proxy em execução, reduzindo o tempo de interrupção. Se a nova versão não iniciar, a atualização pode reverter para a versão anterior.
- Melhorada a reinicialização do serviço do Codex CLI: os demais controles da página continuam utilizáveis enquanto as tarefas em execução terminam, com um indicador de espera e proteção contra reinicializações duplicadas.
- Os catálogos de modelos do Codex agora são atualizados nas verificações de atualização da inicialização e nas verificações manuais de versão. Se o download do catálogo falhar, a configuração atual continua disponível e a verificação de versão segue.
- Atualizados os modelos de referência do Codex incluídos e os parâmetros padrão. As configurações personalizadas salvas são preservadas nas atualizações do catálogo e nas reinicializações do aplicativo.
- Simplificada a restauração dos padrões do modelo com a ação única “Usar padrões”. Clique em Salvar para aplicar os valores restaurados.

## Correções

- Corrigido o risco de novas tentativas de atualização do núcleo sobrescreverem os backups de reversão da versão anterior.
- Corrigido o travamento das atualizações no macOS em comandos de ejeção de DMG e melhorada a limpeza de processos filhos e diretórios temporários após o tempo limite.
- Corrigida a renderização dos temas na inicialização e a migração dos temas salvos, e os fundos das páginas ficaram mais consistentes.
- Quando há API Keys do Codex configuradas e nenhuma política de geração de imagens foi escolhida manualmente, o padrão passa a ser o modo `chat`. As políticas salvas manualmente são preservadas e não são substituídas pelos padrões ao reiniciar.
- Corrigidas as consultas de cota que informavam dados não reconhecidos em algumas contas Codex Business que retornam limites individuais de gastos.
