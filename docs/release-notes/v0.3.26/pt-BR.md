## Notas da versão v0.3.26

- Sugestões e relatos de problemas para este projeto são bem-vindos no chat da comunidade ou no GitHub.
- Esta versão corrige uma falha de configuração ao desativar API Keys e aprimora o gerenciamento de modelos do Claude Code e a interface do Histórico de uso.

## Novidades

- O Claude Code agora conta com controles separados para definir se o CPA gerencia o modelo de inicialização e o modelo do subagente. Quando desativados, o CPA não sobrescreve mais o modelo padrão salvo do Claude Code, e subagentes sem modelo especificado herdam o modelo da sessão principal.

## Melhorias

- Os menus de filtro do Histórico de uso agora ajustam sua largura automaticamente às opções.
- O seletor entre Token e solicitações agora acompanha o estilo do seletor de protocolo na tela Início.
- O campo de nome do modelo nas configurações da credencial voltou a aceitar pesquisa e filtra os resultados pelos IDs de modelos daquela credencial conforme você digita.

## Correções

- Desativar API Keys nativas, como Codex, Claude e Gemini, não grava mais o campo `disabled` sem suporte, que impedia o carregamento de toda a configuração.
- Configurações existentes são reparadas automaticamente antes de o núcleo iniciar, sem necessidade de edição manual. Provedores compatíveis com OpenAI continuam usando o botão de desativação existente.
