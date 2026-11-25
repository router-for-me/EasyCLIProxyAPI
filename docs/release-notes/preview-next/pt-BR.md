Esta prévia corrige as duas coisas que afetavam diretamente a atualização e o download. Uma versão estável trocada para o canal de prévia agora reconhece corretamente uma prévia mais nova e oferece a atualização dentro do aplicativo. E o botão de download manual não ignora mais a fonte de download escolhida: ele monta o link a partir do espelho selecionado (GitHub oficial, gh-proxy, ghfast ou um prefixo personalizado), então quem não consegue acessar o GitHub direto ainda consegue baixar o pacote.

Se tiver problemas, conte para a gente no [Discord](https://discord.gg/your-discord-invite) ou abra uma issue no [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Correções

- **Sem botão de atualizar depois de trocar uma versão estável para o canal de prévia**: as prévias usam versões como `0.3.6-preview.20261106-1137`, que o versionamento semântico sempre coloca abaixo de `0.3.6`. Por isso, trocar de uma versão oficial para o canal de prévia mostrava "nenhuma atualização disponível" e só oferecia o botão de download. As prévias com data e hora no canal de prévia agora são reconhecidas como versão mais nova, e a atualização dentro do aplicativo aparece depois de trocar de canal.
- **O download manual ignorava a fonte de download escolhida**: o botão de download abria o link original do arquivo no GitHub, vindo do manifesto, então o espelho escolhido só valia para buscar a lista de versões, e não para o pacote. O link de download agora usa o prefixo do espelho escolhido, então escolher `ghfast.top` ou `gh-proxy.com` baixa por esse espelho.

## Observações

- As prévias usam o mesmo prefixo de versão e se diferenciam pela hora da compilação; a data e hora da "última compilação" na página de versões é o que separa duas prévias.
- Esta versão ainda não traz a correção da área de clique da faixa de abas das configurações avançadas na largura de 1280; ela ainda está em andamento.
