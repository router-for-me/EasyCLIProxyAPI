- Se tiver dúvidas ou sugestões sobre o aplicativo, fale conosco pelo [grupo do QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). Responderemos o mais rápido possível.

## Correções

- Corrigido um problema no Windows em que a verificação do status de instalação e da versão do VSCode Copilot podia iniciar o VS Code sem querer, restaurar várias janelas e encerrar esses processos à força quando a verificação expirava. Verificações repetidas podiam fazer o editor abrir e fechar sem parar.
- A detecção agora usa o ponto de entrada de linha de comando da instalação correspondente e distingue Stable e Insiders. Se a CLI correspondente não estiver disponível, a detecção não tenta mais iniciar o editor e informa a versão como desconhecida.
