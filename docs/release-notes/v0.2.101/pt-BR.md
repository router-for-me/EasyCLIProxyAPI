## Correções

- Corrigido o problema em que exclusões automáticas em conexões de API bloqueavam um modelo selecionado quando seu alias coincidia com o nome de um modelo de origem desmarcado. Por exemplo, atribuir o alias `dsv4` ao modelo de origem `dsv4.1` não torna mais o mapeamento indisponível só porque o modelo original `dsv4` está desmarcado.
- Após aplicar uma seleção de modelos, editar nomes de modelos ou aliases agora atualiza as exclusões automáticas de acordo. Ao salvar, outros aliases existentes para o mesmo modelo também são protegidos. Listas de exclusão editadas manualmente, regras com curingas e estados de provedores desativados são preservados.

**Configurações existentes:** se exclusões conflitantes tiverem sido salvas anteriormente, use “Buscar modelos → Aplicar seleção → Salvar” novamente para limpar os conflitos gerados automaticamente.

---

## Incluído da v0.2.100

### Novidades

- Adicionada uma caixa de diálogo unificada de configurações da credencial para prefixos de modelos, URLs do proxy, prioridades, pesos na distribuição, espera exponencial, WebSockets, modelos excluídos, cabeçalhos personalizados e observações. Ao salvar, apenas os campos alterados são atualizados, e fechar a janela exibe um aviso sobre alterações não salvas.
- Adicionadas estatísticas de solicitações aos cartões de credenciais, exibindo contagens de sucesso e falha. Quando houver dados recentes do núcleo disponíveis, os cartões também mostram a taxa de sucesso nos últimos 200 minutos e detalhes das solicitações a cada intervalo de 10 minutos.
- Adicionados detalhes de integridade e período de espera das credenciais, incluindo motivos de erro, contagem regressiva do período de espera para credenciais ou modelos individuais, códigos de status HTTP e previsão de término do período de espera. As contagens regressivas usam dados fornecidos pelo núcleo; atualize a lista após o término para confirmar o status mais recente.
- Adicionada a redefinição de cota do Codex ao gerenciamento de credenciais. Quando a credencial oferecer suporte à redefinição e tiver créditos de redefinição disponíveis, é possível redefinir a cota diretamente pelo cartão, com a mesma confirmação e retorno de resultado da página Consulta de cotas.

### Melhorias

- A lista de credenciais foi substituída por cartões responsivos. Barras de progresso exibem a cota restante junto com horários de redefinição, detalhes da assinatura e créditos de redefinição. As observações agora aparecem acima dos botões de ação, facilitando a navegação e o gerenciamento de várias contas.
- Padronizados tamanhos de fonte, pesos e alturas de linha, aprimorada a seleção de fontes para diferentes idiomas e refinada a hierarquia tipográfica nos cartões de credenciais, caixas de diálogo e tabelas de uso.
- Melhorado o contraste de texto nos temas claro e escuro, deixando textos auxiliares, textos de exemplo em campos e conteúdo das tabelas mais fáceis de ler.

### Correções

- Corrigido o problema em que as configurações de credencial e as ações de ativar/desativar ficavam disponíveis para conexões de API ou entradas somente em tempo de execução. Essas ações agora se aplicam apenas a arquivos de credenciais OAuth. A lista de provedores de exclusão de modelos OAuth também inclui apenas provedores com arquivos de credenciais OAuth e esclarece que as exclusões não afetam conexões de API.
- Corrigida a falha na seleção de modelos de agentes em ambientes WebKit, incluindo o macOS, quando clicar em uma opção fechava o seletor antes de a escolha ser aplicada.
- Corrigido o ícone da barra de menus do macOS que não respeitava as configurações de exibir/ocultar do sistema, agora com suporte para lembrar seu estado de visibilidade.
