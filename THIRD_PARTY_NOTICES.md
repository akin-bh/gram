# Third-party notices

gram installs these packages from npm at the versions in [`bun.lock`](bun.lock). None of their code is copied into this repository.

| Package | Version | License |
|---|---|---|
| [emulate](https://github.com/vercel-labs/emulate) | 0.12.2 | Apache-2.0 |
| [@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk-typescript) | 0.3.310 | Anthropic [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) |
| [dialkit](https://github.com/joshpuckett/dialkit) | 2.0.2 | MIT |
| [thinking-orbs](https://github.com/Jakubantalik/Libraries.dev) | 0.3.2 | MIT |
| [marked](https://github.com/markedjs/marked) | 18.1.1 | MIT |
| [postal-mime](https://github.com/postalsys/postal-mime) | 4.1.4 | MIT-0 |
| [zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT |

Development uses [TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0) and [@types/bun](https://github.com/DefinitelyTyped/DefinitelyTyped) (MIT).

The 2026 federal withholding tables in [`src/tax-rules/`](src/tax-rules/) are excerpted from [IRS Publication 15-T](https://www.irs.gov/publications/p15t), a US government work.

The workspace layout takes visual cues from [Define's demo](https://demo.define.app/). No Define code or assets are included.
