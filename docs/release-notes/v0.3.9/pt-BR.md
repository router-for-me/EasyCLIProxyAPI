## Novidades

- Adicionada bandeja do sistema no Linux. Abra a janela principal, consulte o status do núcleo, inicie, pare ou reinicie o núcleo, ou encerre o aplicativo pela bandeja. Também há suporte para fechar para a bandeja e inicialização silenciosa.

## Melhorias

- Atualizado o núcleo incluído para a versão 8.0.3. O aplicativo agora oferece suporte ao layout de configuração v8 e à API de gerenciamento para ler e salvar provedores de API, chaves de acesso, aliases de modelos OAuth, configurações de solicitação e dados relacionados.
- Melhorados os layouts em janelas estreitas. Menus de idioma, abas de páginas, caixas de diálogo e o Histórico de uso agora têm controles por teclado, gerenciamento de foco e rótulos de acessibilidade aprimorados. Também é possível ajustar a largura das colunas do Histórico de uso pelo teclado.
- O inglês passou a ser o idioma padrão quando o idioma do sistema não é compatível. Mensagens de backend antes fixas em chinês agora usam inglês, enquanto os menus da bandeja acompanham o idioma do aplicativo.

## Correções

- Corrigido o problema em que atualizações no macOS perdiam o acesso às credenciais OAuth armazenadas dentro do pacote antigo do aplicativo. As credenciais e seus logs agora são recuperados do backup de atualização para o armazenamento persistente. Se o carregamento da configuração falhar após uma atualização automática, a inicialização é interrompida para que o atualizador possa reverter a atualização em vez de adotar configurações padrão.
- Corrigido o problema em que atualizações do núcleo sobrescreviam configurações existentes com os padrões do modelo v8. Atualizações a partir da v7 e atualizações de configurações v8 migradas parcialmente agora preservam as configurações existentes, incluindo o diretório de credenciais OAuth, a porta e as chaves de acesso.
- Corrigido o problema em que credenciais de API de origem eram sobrescritas por chaves de acesso de clientes durante a inicialização ou ao alterar chaves de acesso em uma configuração v8 sem marcador de versão.
- Os logs de inicialização do núcleo agora são acrescentados à saída existente, preservando o histórico de inicialização quando o núcleo inicia ou reinicia.
- Corrigidas falhas quando nós opcionais da configuração v8 estão ausentes. Melhorados a criação inicial de aliases de modelos e o rollback após falha ao salvar, para que nós pai vazios não sejam confundidos com alterações não relacionadas.
- Corrigido o problema em que o Claude Code acionava verificações do modo automático no servidor ao ser usado por meio de um gateway CPA.
- Corrigido um problema de atualização no macOS em que uma configuração legada de diretório OAuth relativo podia ocultar credenciais existentes. Se o diretório relativo não tiver credenciais e o diretório persistente tiver, o aplicativo volta a usar automaticamente as credenciais existentes.
- Mantida a janela principal acessível quando a bandeja do sistema do Linux estiver indisponível, evitando que a inicialização silenciosa ou a minimização deixe o aplicativo inacessível.
- Estendida a recuperação de diretórios relativos legados de credenciais OAuth para Windows e Linux, e aprimoradas as verificações de caminho no macOS. A configuração e as credenciais existentes são preservadas se a recuperação falhar.
- Corrigida a resolução de diretórios de credenciais OAuth e de logs do núcleo em todas as plataformas, garantindo que os diretórios abertos e os logs de inicialização correspondam aos caminhos usados pelo núcleo.
- Corrigida a gravação incorreta de configurações de TLS, logs e diretório OAuth quando a configuração usa o layout v8 sem marcador de versão. Agora há suporte para atualizações em mapeamentos YAML em estilo flow.
