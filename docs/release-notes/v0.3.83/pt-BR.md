Esta versão completa o login OAuth de várias entradas para plugins: quando um plugin declara vários provedores OAuth, o painel de login agora mostra um cartão por provedor, cada um com o nome e o logotipo que o próprio plugin fornece, e o portal de login pode ser escolhido por entrada.

Se encontrar problemas, avise no [Discord](https://discord.gg/your-discord-invite) ou abra uma issue no [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Novidades

- **Cartões separados para cada provedor OAuth de plugin**: um plugin que oferece várias entradas de login OAuth agora desenha um cartão por provedor, usando o nome e o logotipo declarados por esse plugin, em vez de reuni-los numa única entrada.
- **Seleção de portal por entrada**: o portal de login agora pode ser definido por provedor, e não uma vez para o plugin inteiro.
- **Descoberta de provedores mais robusta**: só são lidos plugins que estão de fato ativados e declaram um provedor OAuth válido. As entradas são deduplicadas por provedor, os integrados ficam de fora, e provedores adicionados pelo backend aparecem sem uma lista de permissão no frontend.
