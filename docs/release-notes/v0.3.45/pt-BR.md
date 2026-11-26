- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Novidades

- Adicionada a configuração **Modelo de aprovação** ao gerenciamento da configuração do Codex. Escolha o padrão do Codex ou um modelo específico, salve-o no catálogo gerenciado e deixe que os modelos recém-descobertos herdem a configuração. O modelo selecionado precisa estar acessível pelo proxy atual.
- Adicionado um interruptor experimental de **Compactação remota** para o Codex, desativado por padrão, para ativar a compactação de contexto no servidor quando o serviço de origem oferecer suporte.
- Adicionada uma opção para usar a identidade de provedor `openai` no Codex e continuar roteando pelo CPA, com backup e sincronização opcionais do histórico local de sessões ao alternar.

## Melhorias

- Os cartões de cota agora aceitam grupos de modelos com janelas de uso separadas e contagens regressivas de redefinição, com informações do plano e posição do botão de atualização revistas.
- O aplicativo agora restaura a posição anterior da janela depois de reiniciar.
- As solicitações de instalação de plugins agora podem ser canceladas com Cancelar, Fechar ou Esc enquanto a instalação está em andamento.

## Correções

- O cálculo do custo de uso agora prefere o preço automático do modelo original real antes de recorrer a outros preços, evitando que preços manuais tenham prioridade de forma inesperada.
- Corrigida a compressão ou o corte das contagens de Tokens de raciocínio quando a coluna de custo está ativada.
- Corrigida a compressão dos rótulos e das descrições das configurações pelos controles de entrada nas páginas de configuração.
- Corrigida a detecção do aplicativo de desktop DeepSeek Harness e da CLI incluída no macOS.

## Notas de uso

- Reinicie o serviço do Codex CLI ou o aplicativo de desktop correspondente depois de alterar essas configurações. O interruptor de compactação remota muda o nome do provedor; se as sessões antigas sumirem, sincronize-as de novo em Gerenciamento de sessões.

## Atualizações anteriores selecionadas

## Correções

- Corrigido um problema no Windows em que a verificação do status de instalação e da versão do VSCode Copilot podia iniciar o VS Code sem querer, restaurar várias janelas e encerrar esses processos à força quando a verificação expirava. Verificações repetidas podiam fazer o editor abrir e fechar sem parar.
- A detecção agora usa o ponto de entrada de linha de comando da instalação correspondente e distingue Stable e Insiders. Se a CLI correspondente não estiver disponível, a detecção não tenta mais iniciar o editor e informa a versão como desconhecida.
