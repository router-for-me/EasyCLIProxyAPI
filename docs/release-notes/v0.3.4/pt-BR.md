## Melhorias

- Atualização automática para o núcleo incluído ao iniciar: se a versão do núcleo instalado for mais antiga que a versão incluída no aplicativo, o CPA agora instala automaticamente o núcleo incluído e restaura seu estado de execução (antes, isso só ocorria quando nenhum núcleo estava instalado).
- Renomeado “Configurações avançadas” para “Recursos avançados” na navegação e em Acesso à API.

## Correções

- Corrigido o problema em que atualizações do aplicativo podiam usar respostas em cache ou estado de tarefa desatualizado, adicionando cabeçalhos contra cache às solicitações de atualização e atualizando os metadados da versão antes de iniciar o download.

---

## Incluído da v0.3.3

### Novidades

- Adicionada uma configuração separada de URL do proxy para cada conexão de API em Acesso à API e no Modo iniciante, com suporte a proxies HTTP, HTTPS e SOCKS5.
- Agora é possível buscar preços de modelos no Histórico de uso a partir do Models.dev ou do LiteLLM. Visualize correspondências, edite preços e selecione quais modelos salvar antes de aplicar a atualização. Preços já inseridos manualmente vêm desmarcados por padrão.

### Melhorias

- Atualizados os preços de modelos incluídos com entradas para GPT-6 Sol, GPT-6 Luna, Grok 4.7 e outros.
- Refinadas as estimativas de custo para leitura do cache, gravação no cache e contextos longos. Preços de cache ausentes não são mais inferidos automaticamente.
- Atualizado o núcleo incluído para a versão 7.3.17.
