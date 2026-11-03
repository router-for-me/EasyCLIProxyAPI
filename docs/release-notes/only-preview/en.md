- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Fixed

- **OpenCode Image Paste and Attachment Support**: Declared `attachment` and `modalities` metadata for generated custom provider models in the OpenCode configuration. Multimodal models now support `text`, `image`, and `pdf` inputs, while image generation models declare `image` output capabilities. This resolves an issue where OpenCode treated custom provider models as text-only and blocked pasting images or attaching PDFs (#567).
