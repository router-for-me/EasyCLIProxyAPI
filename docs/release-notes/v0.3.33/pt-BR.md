- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [Discord](https://discord.gg/PxvX4D9kgs) ou envie pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- Adicionado o Modo de privacidade na barra lateral, que oculta e-mails de contas, IDs de contas e IDs de projetos e lembra sua preferência. A ocultação afeta apenas a exibição; solicitações, buscas, valores copiados e exportações permanecem inalterados.
- Adicionada uma configuração de Token de acesso do GitHub em Serviço e acesso, com controles de exibir/ocultar e um link para criar um Token. As mensagens de limite de taxa da API do GitHub na Loja de plugins agora levam diretamente a essa configuração.
- Adicionada a opção Ativar pausa temporária após falhas em Modelos e requisições. As pausas temporárias vêm desativadas por padrão quando não há configuração definida; configurações explícitas são preservadas.

## Melhorias

- Os cartões de login OAuth agora exibem contas salvas, contagem de contas e status de desativação, com atalho para Arquivos de autenticação. As listas de contas são atualizadas após uma autorização bem-sucedida para facilitar o gerenciamento de várias contas.
- Movida a seção Novas tentativas e pausas temporárias para Modelos e requisições e atualizadas a navegação da busca de configurações e os layouts em tela larga.
- Atualizado o núcleo CLIProxyAPI incluído para a versão v8.0.24.

## Correções

- Corrigidas as mensagens de autorização OAuth para diferenciar a adição de uma conta do novo login em uma conta existente. Entrar novamente atualiza as credenciais daquela conta; as mensagens não afirmam mais que toda autorização cria uma nova conta.
- Corrigido o problema em que a mesclagem de configurações na inicialização podia sobrescrever configurações explícitas de pausa temporária com configurações antigas da interface ou padrões de modelo. As escolhas de ativação ou desativação do usuário são preservadas.
