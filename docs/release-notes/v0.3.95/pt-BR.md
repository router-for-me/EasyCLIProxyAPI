## Novidades

- **A filtragem por tags agora ocupa uma única linha mais um painel flutuante de seleção múltipla**: tanto na página Destaques do ECPA quanto na Loja de plugins, o filtro de tags ocupa uma linha e as demais tags ficam recolhidas em uma seta no fim da linha. Ao abri-la, um painel aparece sobre os cartões permitindo marcar várias tags ao mesmo tempo (os resultados são a união das tags selecionadas), sem empurrar a grade de plugins para baixo. O painel abre para cima quando há pouco espaço, rola internamente quando há muitas tags e nunca corta a última linha de opções.

## Melhorias

- **A grade de plugins em destaque agora aparece de uma só vez**: a página de destaques aguarda tanto o registro quanto a lista da loja de plugins antes de renderizar os cartões, exibindo apenas um indicador de carregamento centralizado enquanto isso, sem desenhar esqueletos que são preenchidos depois.
- **A altura dos cartões não muda mais conforme o estado de carregamento**: o botão de instalação mantém um espaço de largura fixa, de modo que alternar entre Instalar, Instalando e Atualizar não redimensiona o cartão, e a faixa embutida "Carregando lista de plugins" foi removida.
- **A página Loja de plugins agora segue o mesmo padrão da página de destaques**: os cartões da loja usam a mesma estrutura (ícone, nome e ID, selo de versão no canto superior direito, descrição, autor e licença, tags, divisória e barra de ações), com os mesmos botões Copiar ID do plugin, Abrir link e ação principal à direita. A barra de ferramentas da loja agora tem uma única linha com busca, Guia de desenvolvimento e Atualizar — apenas um botão a mais que a página de destaques; o menu suspenso de status sujeito a quebra de linha e os controles de verificar atualizações e instalação local foram removidos dela.
- **O aviso de plugins desativados agora é um selo compacto na barra de ferramentas**: em vez de um banner em largura total quebrando a página, a desativação global aparece como um aviso curto na barra de ferramentas, com a frase completa exibida na dica ao passar o mouse.

## Correções

- **Configurações do proxy reverso perdidas após reiniciar**: as configurações eram gravadas apenas na configuração do núcleo, que é regenerada a cada inicialização do núcleo e podia sobrescrevê-las. Agora elas são salvas na configuração da interface gráfica, e o salvamento também atualiza o estado em memória para que outro salvamento de configuração não as apague ao serializar.
- **Configurações do proxy reverso perdidas durante a migração entre as configurações do núcleo e da interface gráfica**: a migração agora atualiza o arquivo e o estado em memória na mesma etapa, remove a cópia do núcleo somente após ambas as gravações serem concluídas com sucesso e mantém os valores originais para nova tentativa em caso de falha na gravação.
- **Erros antigos ao iniciar o proxy reverso**: uma inicialização bem-sucedida agora limpa erros anteriores de vinculação ou restauração, evitando que um serviço em execução apareça ao lado de uma falha antiga.
