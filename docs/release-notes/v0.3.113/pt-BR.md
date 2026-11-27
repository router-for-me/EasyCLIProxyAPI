Se tiver dúvidas ou sugestões sobre o software, entre em contato pelo [grupo no QQ](https://qm.qq.com/q/3queDaIG) ou pelo [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), e responderemos o mais rápido possível.

## Novidades

- **Contas do ACP podem ser gerenciadas**: contas salvas exibem um rótulo e podem ser removidas localmente, desconectadas individualmente ou autorizadas novamente em um gerenciador compacto de contas, de modo que entrar novamente com um cliente não interfere nos demais.
- **Contas removidas mantêm seu histórico**: remover uma conta salva desvincula os dados dela em vez de destruí-los, e os dados removidos permanecem isolados das contas restantes.

## Melhorias

- **Alterações de conta não deixam mais um estado incompleto**: uma tentativa de autorização não concluída é revertida, e qualquer troca de conta ou termina por completo ou mantém o estado anterior intacto.

## Correções

- **A troca de conta podia deixar um login antigo para trás**: as transições agora falham de forma segura (fail-closed), garantindo que uma autorização com falha ou cancelada não altere o estado da API que estava ativo antes dela.
