- Se tiver dúvidas ou sugestões sobre o software, fale conosco pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelas [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Correções

- **As versões de prévia sempre ofereciam uma versão mais antiga**: o tipo inteiro usado para ler a data e hora da tag de prévia era pequeno demais, então um carimbo como `202611041750` sempre estourava e a busca pela versão de prévia mais recente falhava em silêncio. Agora ele é lido como inteiro de 64 bits, e as atualizações voltam a apontar para a prévia mais nova.
- **O proxy reverso desativado voltava ativado ao reiniciar**: desligar o proxy reverso e reiniciar o aplicativo trazia o interruptor de volta para ativado. O estado agora é salvo e restaurado corretamente.
- **O aviso de reinício do proxy reverso era sobrescrito**: depois de mudar as configurações do proxy reverso, a marcação de reinício necessário não é mais apagada por gravações seguintes, e o caminho da configuração do núcleo é resolvido corretamente.

## Melhorias

- **Tags únicas para as versões de prévia**: cada versão de prévia agora usa uma tag única com data e hora, e as prévias antigas são removidas automaticamente, então uma versão não sobrescreve mais a outra.
- **Descrição mais clara do canal de download**: a página de gerenciamento de versões agora separa os destinos de download de prévia e estável e explica o que cada canal contém.
- **Estados melhores na página MCP e skills**: uma falha ao carregar mostra uma faixa de erro na própria página e um estado vazio, em vez de uma página em branco, e o espaçamento e o layout da lista foram refinados.
- **Itens MCP sincronizados com a configuração do OpenClaw**: servidores MCP e skills de agente agora podem ser gravados direto na configuração do OpenClaw, em vez de copiados à mão.
