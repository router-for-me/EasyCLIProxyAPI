- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Novidades

- Adicionado o tema “渐离の梦境”, com degradês em roxo e rosa e painéis foscos translúcidos. Escolha Crepúsculo estrelado, Céu de Sakura ou Somente degradê, ou carregue e remova o seu próprio papel de parede.
- O seletor de temas agora inclui um guia para criar temas personalizados. Copie um prompt com as regras, um exemplo completo e o JSON Schema e peça a uma IA para criar um tema a partir das suas preferências ou de uma imagem de referência.
- O diálogo de exclusão de sessão do Codex agora oferece a opção “Criar um backup antes de excluir”, ativada por padrão. Desative-a para excluir direto, com um aviso de que a exclusão não pode ser recuperada.

## Melhorias

- Refinados os cartões, as bordas, as sombras e a navegação da área de trabalho. Categorias vazias de provedores de API ficam menos destacadas, os rótulos de contas OAuth têm pontos de status e os cartões de estatísticas de uso têm uma hierarquia visual mais clara.
- As cotas do Kimi agora mostram a cota mensal total e a cota mensal de programação, com os horários de redefinição, além do nome do plano quando disponível.
- Os horários de redefinição e os botões de atualização ficam alinhados no rodapé dos cartões de cota, em um layout mais compacto.
- Atualizada a versão do núcleo para a v8.0.48.

## Correções

- Corrigida a escolha do domínio errado nas consultas de cota do Kimi. As consultas agora selecionam kimi.com ou kimi.ai a partir das informações da credencial, no mesmo comportamento do Management Center.
- Corrigida a manutenção da posição de rolagem da página anterior depois da navegação. As páginas recém-abertas começam no topo.
- Corrigida a aplicação de mudanças de papel de parede mesmo quando o salvamento falhava. Falhas ao carregar a imagem ou no armazenamento local agora mostram um erro e preservam as configurações de exibição anteriores.
- Corrigido o diálogo de exclusão de sessão do Codex sendo empurrado para fora da janela por títulos longos ou muitas seleções. O conteúdo rola e os botões de ação permanecem visíveis.
