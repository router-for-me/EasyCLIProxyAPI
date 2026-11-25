## Novidades

- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo chat da comunidade ou envie pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.
- Adicionada a importação de credenciais do Vertex AI. Selecione o arquivo JSON de uma conta de serviço do Google na página de login, defina opcionalmente a localização no GCP e visualize o projeto, a conta de serviço e o arquivo de credenciais após a importação.
- A Configuração de agentes agora permite selecionar um executável manualmente. Quando a detecção automática falhar, o caminho selecionado é usado para detecção e inicialização.
- O Histórico de uso agora exibe um selo Fast para solicitações `priority` e `fast`.

## Melhorias

- Redesenhado o painel inicial com um layout de visão geral mais leve, colocando status e resumo em primeiro plano.
- Adicionada uma opção de quebra de linha para detalhes de erro na Configuração de exibição de uso. As mensagens ficam em uma única linha por padrão e podem ser expandidas; a preferência é salva.
- Melhoradas a atualização e a detecção de configuração do ZCode para aceitar formatos existentes de Base URL e preservar janelas de contexto em modelos configurados manualmente.
- Melhorada a compatibilidade com Hermes e OpenClaw: reconhecimento de entradas de provedores do Hermes v12, respeito a caminhos personalizados de configuração do OpenClaw e preservação dos metadados de modelos existentes.
- Esclarecido que os totais de uso das credenciais correspondem à sessão atual do núcleo, tornados mais claros o status de ativação da credencial e seu botão de ação, e traduzidos os rótulos restantes da interface.
- Atualizado o núcleo CLIProxyAPI incluído para a versão **8.0.22**.
- Melhorado o mapeamento de modelos do Claude Code.

## Correções

- Corrigido um problema com caminhos de links simbólicos.
