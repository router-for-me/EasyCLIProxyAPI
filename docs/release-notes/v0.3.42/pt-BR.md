- Se tiver dúvidas ou sugestões sobre o software, fale conosco no [Discord](https://discord.gg/PxvX4D9kgs) ou envie-as pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Vamos atendê-las o mais rápido possível.

## Novidades

- Adicionada a recuperação automática de encerramentos inesperados do núcleo. Enquanto o aplicativo está em execução, um núcleo que tenha sido iniciado ou assumido com sucesso é reiniciado automaticamente depois de um encerramento inesperado, com até três tentativas em cinco minutos. A tela Início mostra o andamento da recuperação e os detalhes da falha, e a recuperação pode ser interrompida manualmente.
- Adicionada a instalação de plugin local a partir de um arquivo de plugin para a plataforma atual, com um link para o Guia de desenvolvimento.
- Adicionada a ordenação por arrastar e soltar das páginas de plugins na barra lateral. A ordem é salva automaticamente, e os plugins mantêm as posições ao serem desativados e ativados de novo.

## Melhorias

- Núcleo atualizado para a v8.0.32.
- Ao atualizar a lista de plugins locais, a verificação de atualizações também ocorre, mostrando a versão instalada, a versão disponível e a ação de atualizar diretamente.
- Melhorado o retorno depois de instalar, ativar ou desativar plugins, distinguindo alterações já aplicadas, carregamento pendente, reinício necessário e plugins desativados globalmente. O status de carregamento é acompanhado automaticamente.
- As entradas da loja de plugins agora mostram com mais clareza a fonte da loja e o repositório de código. Instalar ou atualizar plugins não oficiais exige confirmação digitada.
- As configurações de plugins foram reunidas na aba Configurações de plugins, na página Plugins. Os layouts de Início, de configurações e de plugins foram simplificados, a busca e a navegação por abas foram alinhadas e títulos e espaçamentos redundantes foram reduzidos.
- As entradas de Acesso à API agora usam a observação como título principal quando ela existe, o que facilita identificar as configurações de provedores.

## Correções

- Corrigidos backups de reversão restantes de atualizações anteriores do núcleo que bloqueavam as atualizações seguintes. Os backups antigos agora são arquivados e preservados antes que outra atualização continue.
- Corrigida a falha na correspondência das observações de origem do uso quando várias configurações de API compartilham a mesma chave.
- Corrigida a falha da instalação de plugins locais em sistemas de arquivos sem suporte a hard link, como FAT/exFAT, sem deixar de impedir que arquivos de plugins já existentes sejam sobrescritos.

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
