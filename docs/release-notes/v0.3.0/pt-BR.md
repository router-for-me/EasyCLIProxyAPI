## Novidades

- Adicionado suporte ao WorkBuddy / WorkBuddy AI na Configuração de agentes. É possível detectar a instalação, aplicar ou desativar a configuração, fazer backup e restaurar configurações e iniciar ou reiniciar o cliente. Há suporte aos formatos de objeto e array em `models.json`, preservando modelos personalizados existentes. Após aplicar, selecione `CPA:nome do modelo` no WorkBuddy. As conversas existentes mantêm o modelo atual; reinicie o aplicativo se o modelo do CPA não aparecer.
- Adicionado suporte ao Cursor CLI (`cursor-agent`) na Configuração de agentes. O CPA detecta a instalação local e permite iniciá-lo com o terminal e o diretório de trabalho escolhidos. O Cursor CLI usa sua própria configuração e sistema de contas, e não o roteamento local de modelos do CPA.
- Adicionado suporte ao Antigravity CLI na Configuração de agentes. Ele se conecta pela API compatível com Gemini do CPA. Após aplicar a configuração, inicie-o por esta página para que o CPA injete o endpoint e a API Key nesse processo. Executar `agy` diretamente exige definir essas variáveis de ambiente manualmente.

## Melhorias

- Redesenhados os cartões de acesso à API na tela Início em linhas de largura total, um protocolo por linha, alinhados ao painel de controle. Clique em uma URL para copiar o endereço local ou da rede local, com confirmação clara da cópia.
- Compactada a visão geral de uso em uma única linha com 6 cartões de estatísticas, conteúdo mais enxuto e alinhamento em largura total, facilitando a leitura de volume de solicitações, desempenho, Tokens e custo.
- Atualizado o núcleo incluído para a versão 7.3.10.

## Correções

- Corrigido o desaparecimento rápido da dica flutuante do gráfico de tendência de uso ao passar o cursor. Agora ela permanece visível enquanto o ponteiro estiver sobre o gráfico e só fecha quando o ponteiro sai ou ao pressionar Esc.

---

## Incluído da v0.2.101

### Correções

- Corrigido o problema em que exclusões automáticas em conexões de API bloqueavam um modelo selecionado quando seu alias coincidia com o nome de um modelo de origem desmarcado. Por exemplo, atribuir o alias `dsv4` ao modelo de origem `dsv4.1` não torna mais o mapeamento indisponível só porque o modelo original `dsv4` está desmarcado.
- Após aplicar uma seleção de modelos, editar nomes de modelos ou aliases agora atualiza as exclusões automáticas de acordo. Ao salvar, outros aliases existentes para o mesmo modelo também são protegidos. Listas de exclusão editadas manualmente, regras com curingas e estados de provedores desativados são preservados.

**Configurações existentes:** se exclusões conflitantes tiverem sido salvas anteriormente, use “Buscar modelos → Aplicar seleção → Salvar” novamente para limpar os conflitos gerados automaticamente.
