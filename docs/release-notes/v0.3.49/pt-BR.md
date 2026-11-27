- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Correções

- Esta versão inclui a correção da pasta de logs que faltava nos pacotes iniciais da v0.3.48. Se o erro persistir na v0.3.48, atualize para esta versão e reinicie o aplicativo.
- Corrigido um erro de estouro de pilha (`Maximum call stack size exceeded`) ao abrir a pasta de logs em Configurações avançadas.
- Restaurada uma janela principal opaca no Linux para tratar conteúdo parcialmente em branco ou transparente depois de passar o cursor, conforme relatado em AMD / KDE e NVIDIA / Hyprland. Os temas translúcidos nativos no Windows e no macOS continuam com suporte. [#491](https://github.com/router-for-me/EasyCLIProxyAPI/issues/491)

## Melhorias

- Reduzido o trabalho da interface em segundo plano: a inicialização silenciosa, minimizar e ocultar na bandeja do sistema agora sincronizam a visibilidade dos WebViews principal e de plugins e pausam as consultas periódicas da interface e as contagens regressivas. Restaurar a janela atualiza os dados atuais; o núcleo do proxy e a coleta de uso continuam em execução. [#493](https://github.com/router-for-me/EasyCLIProxyAPI/issues/493)
- As atualizações de uso agora agrupam os eventos, e a consulta periódica de reserva passou de uma vez por segundo para uma vez a cada 10 segundos. Os eventos de atualização de uso não são mais enviados à interface oculta, o que reduz consultas e trabalho de renderização em segundo plano.
- Restaurada a limitação padrão do navegador em segundo plano. O agendamento da atualização da interface usa a visibilidade nativa da janela e o estado minimizado, então perder o foco sozinho não pausa as atualizações.
- Atualizado o Tauri para a versão estável 2.12.4 e atualizadas as dependências de tempo de execução e de compilação relacionadas.

## Atualizações anteriores selecionadas

### Novidades

- Adicionada a configuração **Modelo de aprovação** ao gerenciamento da configuração do Codex. Escolha o padrão do Codex ou um modelo específico, salve-o no catálogo gerenciado e deixe que os modelos recém-descobertos herdem a configuração. O modelo selecionado precisa estar acessível pelo proxy atual.
- Adicionado um interruptor experimental de **Compactação remota** para o Codex, desativado por padrão, para ativar a compactação de contexto no servidor quando o serviço de origem oferecer suporte.
- Adicionada uma opção para usar a identidade de provedor `openai` no Codex e continuar roteando pelo CPA, com backup e sincronização opcionais do histórico local de sessões ao alternar.

### Melhorias

- Os cartões de cota agora aceitam grupos de modelos com janelas de uso separadas e contagens regressivas de redefinição, com informações do plano e posição do botão de atualização revistas.
- O aplicativo agora restaura a posição anterior da janela depois de reiniciar.
- As solicitações de instalação de plugins agora podem ser canceladas com Cancelar, Fechar ou Esc enquanto a instalação está em andamento.

### Correções

- O cálculo do custo de uso agora prefere o preço automático do modelo original real antes de recorrer a outros preços, evitando que preços manuais tenham prioridade de forma inesperada.
- Corrigida a compressão ou o corte das contagens de Tokens de raciocínio quando a coluna de custo está ativada.
- Corrigida a compressão dos rótulos e das descrições das configurações pelos controles de entrada nas páginas de configuração.
- Corrigida a detecção do aplicativo de desktop DeepSeek Harness e da CLI incluída no macOS.

### Notas de uso

- Reinicie o serviço do Codex CLI ou o aplicativo de desktop correspondente depois de alterar essas configurações. O interruptor de compactação remota muda o nome do provedor; se as sessões antigas sumirem, sincronize-as de novo em Gerenciamento de sessões.
