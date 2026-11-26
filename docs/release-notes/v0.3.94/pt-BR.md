- Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Correções

- **Tela preta ao restaurar uma janela minimizada pela barra de tarefas**: no Windows, clicar repetidamente no ícone da barra de tarefas para minimizar e restaurar podia exibir uma janela totalmente preta por 0,3–1 segundo ou deixar apenas uma faixa estreita da barra de título no canto superior esquerdo. O controlador do WebView agora permanece anexado enquanto minimizado, preservando a superfície do compositor e evitando que a visualização principal seja comprimida para o tamanho minimizado; a interface aparece imediatamente ao restaurar.
- **Estado de visibilidade desatualizado após restaurar da bandeja**: restaurar da bandeja do sistema agora ressincroniza o estado da janela, evitando que o aplicativo continue se comportando como se ela ainda estivesse minimizada.

## Melhorias

- **Sem consultas ociosas enquanto a janela está oculta**: a consulta de status do proxy reverso e o atraso pré-restauração não são mais executados quando a janela não está visível, reduzindo visivelmente o uso de CPU enquanto minimizada.
- **Menor frequência nas consultas de status do núcleo e da fila de uso**: depois que o núcleo está pronto, a verificação de status passa a rodar a cada 10 segundos, e a fila de uso ociosa reduz a frequência em vez de consultar o núcleo a cada segundo.
