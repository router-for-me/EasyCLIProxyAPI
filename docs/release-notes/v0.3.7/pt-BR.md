## Novidades

- Adicionada bandeja do sistema no Linux. Abra a janela principal, consulte o status do núcleo, inicie, pare ou reinicie o núcleo, ou encerre o aplicativo pela bandeja. Também há suporte para fechar para a bandeja e inicialização silenciosa.

## Melhorias

- Atualizado o núcleo incluído para a versão 8.0.2. O aplicativo agora oferece suporte ao layout de configuração v8 e à API de gerenciamento para ler e salvar provedores de API, chaves de acesso, aliases de modelos OAuth, configurações de solicitação e dados relacionados.
- Melhorados os layouts em janelas estreitas. Menus de idioma, abas de páginas, caixas de diálogo e o Histórico de uso agora têm controles por teclado, gerenciamento de foco e rótulos de acessibilidade aprimorados. Também é possível ajustar a largura das colunas do Histórico de uso pelo teclado.
- O inglês passou a ser o idioma padrão quando o idioma do sistema não é compatível. Mensagens de backend antes fixas em chinês agora usam inglês, enquanto os menus da bandeja acompanham o idioma do aplicativo.

## Correções

- Corrigidas falhas quando nós opcionais da configuração v8 estão ausentes. Melhorados a criação inicial de aliases de modelos e o rollback após falha ao salvar, para que nós pai vazios não sejam confundidos com alterações não relacionadas.
- Corrigido o problema em que o Claude Code acionava verificações do modo automático no servidor ao ser usado por meio de um gateway CPA.
- Corrigido um problema de atualização no macOS em que uma configuração legada de diretório OAuth relativo podia ocultar credenciais existentes. Se o diretório relativo não tiver credenciais e o diretório persistente tiver, o aplicativo volta a usar automaticamente as credenciais existentes.
- Mantida a janela principal acessível quando a bandeja do sistema do Linux estiver indisponível, evitando que a inicialização silenciosa ou a minimização deixe o aplicativo inacessível.

## Desenvolvimento

- Adicionado um modo de simulação no navegador para desenvolver, visualizar e verificar a interface sem executar o núcleo do aplicativo de desktop.
