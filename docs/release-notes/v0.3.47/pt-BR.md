- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Novidades


## Melhorias

- Restaurada a barra de título personalizada com tema e os controles de janela no Windows, preservando o posicionamento dos plugins e as correções de DPI entre monitores.
- Unificados os estilos de diálogos, botões, interruptores, caixas de seleção, abas e cartões, com melhor navegação por teclado, tratamento de foco e consistência entre os temas.
- Alinhadas as abas Plugins locais, Loja de plugins e Configurações de plugins à navegação de Configurações avançadas, usando texto em destaque e um sublinhado fino, no lugar de abas em caixa e fundos preenchidos na seleção.
- Refinados os controles de atualização dos cartões de cota e os detalhes de erro. Fechar uma configuração de plugin não salva agora pede confirmação.

## Correções

- Corrigidos travamentos da interface depois de abrir diálogos e janelas pretas depois de restaurar, em ambientes Linux afetados com NVIDIA + Wayland, ao deixar de forçar a preferência por X11 nesses casos. Backends gráficos escolhidos explicitamente pelo usuário continuam respeitados.
- Corrigidas posições de janela e tamanhos de interface restaurados de forma incorreta no macOS em configurações com telas de fatores de escala diferentes.
- Corrigidos avisos flutuantes que deixavam o conteúdo da página aparecer pelo fundo e dificultavam a leitura do texto, inclusive com superfícies de aviso melhores para temas translúcidos.
- Corrigidas a sobreposição do seletor de modelos e o tratamento de Escape dentro de diálogos.

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
