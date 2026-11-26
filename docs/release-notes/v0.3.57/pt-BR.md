- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Correções

- Alinhada a página de configuração do Pi ao catálogo de modelos do plugin, filtrando modelos ocultos e validando o modelo padrão com a mesma lista, para evitar a seleção de modelos indisponíveis no Pi. [#527](https://github.com/router-for-me/EasyCLIProxyAPI/pull/527)
- Instalar ou atualizar o plugin do Pi, ou aplicar a configuração dele, agora limpa o cache antigo de modelos, para que o Pi busque o catálogo mais recente na próxima inicialização. Se o cache não puder ser limpo, as gravações seguintes da configuração param com um erro.
- Corrigida uma falha de compilação causada por um campo de nível de raciocínio ausente na inicialização dos modelos do Pi, mantendo o suporte já existente aos níveis de raciocínio do ZCode.

## Melhorias

- Os modelos conectados ao DeepSeek Harness pelo CPA agora usam por padrão entrada de texto e de imagem, inclusive IDs de modelo personalizados e modelos sem metadados de visão. Reaplicar a configuração atualiza as definições geradas antes e preserva as substituições manuais.

## Notas de uso

- Depois de atualizar, reaplique a configuração do DeepSeek Harness e reinicie o aplicativo ou o serviço Web. Reinicie o Pi depois de alterar a configuração para carregar a lista de modelos mais recente.
- As configurações de entrada de imagem permitem que o cliente envie imagens; o suporte real à visão ainda depende do modelo selecionado e do serviço de origem.

## Atualizações anteriores selecionadas

### Novidades

- Adicionado o botão Reiniciar aplicativo para o DeepSeek Harness Desktop, no mesmo padrão dos controles do Codex App, com suporte a instalações detectadas automaticamente e a caminhos de executável configurados manualmente.
- Reiniciar aplicativo e o controle existente Reiniciar servidor Web controlam, separadamente, o aplicativo de desktop e o serviço Web. Reiniciar aplicativo fica desativado quando nenhuma instalação de desktop é detectada.

### Correções

- Corrigida a ausência de opções de nível de raciocínio nas configurações do ZCode geradas pelo aplicativo. As opções agora refletem os níveis aceitos por cada modelo, inclusive IDs de modelo personalizados, e preservam as configurações manuais existentes.
- Depois de atualizar, reaplique a configuração do ZCode, encerre o ZCode por completo e reinicie-o; em seguida, inicie uma nova sessão para usar as opções de raciocínio atualizadas.
