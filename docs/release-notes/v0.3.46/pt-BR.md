- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Melhorias

- Restauradas a barra de título nativa do Windows e as bordas da janela, com a remoção da barra de título personalizada e das correções de compatibilidade dela. Arrastar, minimizar, maximizar e fechar a janela agora usam os controles do sistema.
- Refinadas a barra de categorias e o campo de busca em Configurações avançadas, com controles mais curtos e mais espaço vertical. As categorias selecionadas agora usam texto em destaque e um sublinhado fino, no lugar de um fundo preenchido.
- Atualizada a versão padrão do núcleo para **8.0.34**.

## Correções

- Corrigido o deslocamento das páginas de plugins para a esquerda, a sobreposição da barra lateral ou a grande área em branco no topo quando a escala é diferente. O posicionamento dos plugins agora usa as dimensões e a posição reais da área de cliente do WebView principal.
- Corrigida a falta de atualização do posicionamento dos plugins depois de mudanças de monitor ou de DPI. Os limites dos plugins são reaplicados mesmo quando as dimensões de layout da página não mudam.
- A detecção do VS Code / Copilot no Windows, no macOS e no Linux agora lê os metadados de instalação e de extensão diretamente, sem executar o editor nem o ponto de entrada de linha de comando, o que impede que a verificação de status inicie o editor sem querer ou encerre processos relacionados depois de um tempo limite.

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
