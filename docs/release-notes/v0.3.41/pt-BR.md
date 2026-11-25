- Se tiver dúvidas ou sugestões sobre o software, fale conosco no [Discord](https://discord.gg/PxvX4D9kgs) ou envie-as pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Vamos atendê-las o mais rápido possível.

## Melhorias

- Atualizadas as consultas de cota do Antigravity para acompanhar a implementação mais recente.

## Atualizações anteriores selecionadas

## Novidades

- Adicionadas entradas na barra lateral para as páginas fornecidas pelos plugins ativados. Abra-as diretamente no aplicativo, com controles para voltar, recarregar ou abrir no navegador.
- Adicionados os temas Areia quente, Grafite, Azul meia-noite e Rosa Sakura. Escolha temas claro e escuro separadamente e alterne entre eles automaticamente com a aparência do sistema.
- Adicionados os detalhes do limite individual de gastos das contas Codex Business, incluindo créditos usados e totais, percentual restante e horário de redefinição.
- Adicionado suporte para reiniciar o app-server do Codex CLI.
- Adicionado suporte à configuração do VS Code Copilot.
- Adicionada a funcionalidade experimental de edição de contexto.

## Melhorias

- Ao atualizar a loja de plugins, as versões mais recentes dos repositórios públicos do GitHub são consultadas diretamente, reduzindo atrasos causados por informações de versão em cache.
- A configuração do VS Code Copilot agora inclui todos os modelos disponíveis, com janelas de contexto e entrada de imagem definidas conforme a capacidade de cada modelo. A entrada de imagem fica ativada por padrão quando faltam informações de modalidade de entrada.
- Melhorada a detecção de capacidades dos modelos para reconhecer mais campos de modalidade de entrada e de limite de saída, e para propagar as modalidades de entrada e o número máximo de Tokens de saída para a configuração do OpenClaw.
- Simplificados o fundo, a borda e os ícones do botão Aparência da barra lateral, para combinar melhor com os controles ao redor.
- As atualizações do núcleo agora concluem o download e a extração antes de interromper o proxy em execução, reduzindo o tempo de interrupção. Se a nova versão não iniciar, a atualização pode reverter para a versão anterior.

## Correções

- Corrigida a falha de núcleos assinados no macOS ao carregar plugins nativos.
- Corrigida a possível perda dos níveis de velocidade nas atualizações do catálogo de modelos do Codex e a demora para que alterações nos arquivos do catálogo passem a valer.
- Corrigidos estilos inconsistentes de botões, campos e menus suspensos em alguns temas, e menus suspensos abertos que não atualizavam ao trocar de tema.
- Corrigida a falha na exibição do número da versão do aplicativo na interface.
- Corrigido o aviso de reinicialização do Codex CLI que permanecia ou sumia ao navegar entre páginas.
- Reforçada a validação de links simbólicos ao gravar a configuração do cliente, para impedir que links de configuração aninhados apontem para diretórios raiz da estrutura.
