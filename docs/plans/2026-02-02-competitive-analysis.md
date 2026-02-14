# AgentMe - Competitive Analysis & Feature Roadmap

**Datum:** 2026-02-02
**Status:** Draft
**Verze:** 0.2 (verified sources)

---

## 1. Executive Summary

Tento dokument analyzuje konkurenční projekty v oblasti decentralizovaných AI agent marketplaces a identifikuje klíčové features, které by AgentMe měl implementovat pro získání konkurenční výhody.

### Klíčoví konkurenti

| Projekt | Market Cap | Focus | Open Source | Threat Level |
|---------|------------|-------|-------------|--------------|
| **[Olas](https://olas.network)** | ~$100M+ | Agent-to-agent marketplace | ✅ MIT License | 🔴 Vysoký |
| **[Virtuals Protocol](https://virtuals.io)** | ~$408M (únor 2026) | Agent tokenizace, gaming | ✅ Částečně | 🟡 Střední |
| **[Fetch.ai / ASI Alliance](https://fetch.ai)** | ~$1.5B | Enterprise AI, Visa integrace | ✅ Apache 2.0 | 🟡 Střední |
| **[Bittensor](https://bittensor.com)** | ~$3B | Decentralizovaný compute | ✅ MIT License | 🟢 Nízký |

### Strategická pozice AgentMe

AgentMe má unikátní příležitost v:
1. **Enterprise compliance** (HIPAA, SOC2, GDPR)
2. **Dispute resolution** (tiered system - jediný na trhu)
3. **Claude Code native bridge** (Anthropic ekosystém)
4. **Regulated industries** (healthcare, finance, legal)

---

## 2. Competitor Deep Dive

### 2.1 Olas Mech Marketplace

| | |
|---|---|
| **Website** | https://olas.network/mech-marketplace |
| **GitHub** | https://github.com/valory-xyz |
| **License** | MIT ([source](https://github.com/valory-xyz/autonolas-governance)) |
| **Documentation** | https://docs.autonolas.network/ |
| **Funding** | $13.8M (únor 2025, [source](https://siliconangle.com/2025/02/05/olas-raises-13-8m-launch-decentralized-app-store-ai-agents/)) |

**Co to je:**
Decentralizovaný marketplace kde AI agenti ("Mechs") nabízejí služby jiným agentům. Spuštěn únor 2025.

**Ověřené metriky (Q1 2025):**

| Metrika | Hodnota | Zdroj |
|---------|---------|-------|
| Celkové transakce | 5,251,860 | [Olas Q1 Report](https://olas.network/blog/q-1) |
| Agent-to-agent requesty | 3.45M | [Olas Q1 Report](https://olas.network/blog/q-1) |
| Daily Active Agents | 599 | [Olas Q1 Report](https://olas.network/blog/q-1) |
| Podporované chains | 9 (ETH, SOL, Base, Polygon, Arbitrum, Optimism, Gnosis) | [Olas FAQ](https://olas.network/faq) |
| Deploynutí agenti | ~2,000 | [CoinDesk](https://www.coindesk.com/markets/2025/02/27/olas-mech-marketplace-enables-ai-agents-to-hire-each-other-for-help) |

**Konkrétní příklad - Olas Predict:**

```
Use case: Prediction market agenti
URL: https://olas.network/agent-economies/predict

Jak funguje:
1. Market Creator agent vytvoří prediction market
2. Prediction Broker (Mech) analyzuje data pomocí LLM
3. Trader agent automaticky sází na základě AI analýzy
4. Výsledky: 79% prediction accuracy, 300+ daily active agents

Download: https://olas.network/pearl#download
```

**Architektura:**

```
┌─────────────────────────────────────────────────────────────┐
│                    OLAS MECH MARKETPLACE                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐                      ┌─────────────┐       │
│  │ Requesting  │  on-chain request    │    Mech     │       │
│  │   Agent     │─────────────────────▶│   Agent     │       │
│  └─────────────┘   (crypto payment)   └──────┬──────┘       │
│                                              │              │
│                                     off-chain│execution     │
│                                              │              │
│                                              ▼              │
│                                       ┌──────────────┐      │
│                                       │  LLM / API   │      │
│                                       │   Service    │      │
│                                       └──────┬───────┘      │
│                                              │              │
│  ┌─────────────┐  on-chain result     ┌──────▼──────┐       │
│  │ Requesting  │◀─────────────────────│    Mech     │       │
│  │   Agent     │  (verifiable proof)  │   Agent     │       │
│  └─────────────┘                      └─────────────┘       │
│                                                             │
│  Key: Žádné API klíče - jen kryptografické signatury       │
└─────────────────────────────────────────────────────────────┘
```

**Open Source repos k prostudování:**

| Repo | Popis | URL |
|------|-------|-----|
| autonolas-governance | OLAS token + governance | https://github.com/valory-xyz/autonolas-governance |
| autonolas-registries | Agent/service registry (ERC721) | https://github.com/valory-xyz/autonolas-registries |
| open-autonomy | Framework pro autonomní agenty | https://github.com/valory-xyz/open-autonomy |
| mech | Mech agent implementace | https://github.com/valory-xyz/mech |

**Co ukrást:**

| Feature | Implementace v Olas | Priorita |
|---------|---------------------|----------|
| Dynamic discovery | Marketplace UI bez hardcoded adres | 🔴 High |
| Crypto-only auth | Wallet signature místo API keys | 🔴 High |
| On-chain audit trail | Request/response on-chain | 🟡 Medium |
| Multi-chain | 9 chains support | 🔴 High |

**Slabiny (příležitosti pro AgentMe):**
- ❌ Žádný dispute resolution systém
- ❌ Žádná enterprise compliance
- ❌ Crypto-only (žádný fiat off-ramp)
- ❌ Omezená dokumentace pro začátečníky

---

### 2.2 Virtuals Protocol

| | |
|---|---|
| **Website** | https://virtuals.io |
| **GitHub** | https://github.com/Virtual-Protocol (28 repos) |
| **License** | Částečně open source |
| **Documentation** | https://whitepaper.virtuals.io |
| **Token** | VIRTUAL ([CoinMarketCap](https://coinmarketcap.com/currencies/virtual-protocol/)) |

**Co to je:**
"Shopify pro AI agenty" - platforma pro tokenizaci a co-ownership AI agentů. Focus na gaming a entertainment.

**Ověřené metriky:**

| Metrika | Hodnota | Zdroj |
|---------|---------|-------|
| VIRTUAL Market Cap | ~$408M (únor 2026) | [CoinMarketCap](https://coinmarketcap.com/currencies/virtual-protocol/) |
| ATH Market Cap | $4.5B (leden 2025) | [BanklessTimes](https://www.banklesstimes.com/articles/2025/01/02/virtual-protocol-at-5-billion-are-ai-agents-the-2025-meta/) |
| DEX Volume | $8B+ traded | [Messari](https://messari.io/report/understanding-virtuals-protocol-a-comprehensive-overview) |
| Total Supply | 1,000,000,000 VIRTUAL | [CoinGecko](https://www.coingecko.com/en/coins/virtual-protocol) |
| Circulating | ~656M | [CoinGecko](https://www.coingecko.com/en/coins/virtual-protocol) |

**Top AI Agenti (ověřené market caps):**

| Agent | Popis | Peak Market Cap | Aktuální | Zdroj |
|-------|-------|-----------------|----------|-------|
| [AIXBT](https://www.coingecko.com/en/coins/aixbt-by-virtuals) | AI market analyst, monitoruje 400+ KOLs | $700M | ~$115M | [CoinGecko](https://www.coingecko.com/en/categories/virtuals-protocol-ecosystem) |
| LUNA | AI virtual idol, TikTok influencer | $100M | - | [Gate.com](https://www.gate.com/crypto-wiki/article/top-ai-agent-projects-on-base-blockchain-network-to-know-in-2025-20260109) |
| G.A.M.E. | Gaming AI agent | $357M | - | [Messari](https://messari.io/report/understanding-virtuals-protocol-a-comprehensive-overview) |

**Konkrétní příklad - LUNA agent:**

```
Agent: LUNA (@luna_virtuals)
Typ: AI virtual idol / influencer
Platforma: TikTok, Twitter

Co dělá:
- Automaticky generuje content
- Najímá JINÉ AI agenty pro tvorbu grafiky
- Platí real-world graffiti umělce ze svého walletu
- Cíl: 100,000 followers

Unikátní: Agent má vlastní wallet a autonomně utrácí
```

**Tokenomics model (ověřený):**

```
┌─────────────────────────────────────────────────────────────┐
│           VIRTUALS TOKENIZATION MODEL (verified)             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Agent Creation:                                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  100 VIRTUAL tokens (~$62) → Launch na bonding curve │   │
│  │  Source: whitepaper.virtuals.io                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Token Distribution:                                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Total supply: 1,000,000,000 agent tokens            │   │
│  │  ├── 10% initial liquidity (bonding curve)           │   │
│  │  └── 90% vesting (max 10% emission/year for 3 years) │   │
│  │  Source: CryptoRank tokenomics                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Revenue Flow (deflationary):                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Protocol revenue → Buy-back & burn VIRTUAL          │   │
│  │  Source: CoinMarketCap                               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Governance (od července 2025):                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Stake VIRTUAL → veVIRTUAL → DAO voting              │   │
│  │  Source: 99bitcoins.com                              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Open Source repos k prostudování:**

| Repo | Popis | URL |
|------|-------|-----|
| game-node | GAME agent SDK (TypeScript) | https://github.com/game-by-virtuals/game-node |
| virtuals-python | Python SDK | https://github.com/Virtual-Protocol/virtuals-python |
| koopa-virtuals | Web crawler pro agenty | https://github.com/Virtual-Protocol/koopa-virtuals |
| protocol-contracts | Governance contracts | https://github.com/Virtual-Protocol/protocol-contracts |

**Instalace:**
```bash
npm install @virtuals-protocol/game
```

**Co ukrást:**

| Feature | Implementace | Priorita |
|---------|--------------|----------|
| Agent tokenizace | ERC-20 per agent, bonding curve | 🔴 High |
| Agent wallet | Agent autonomně spravuje funds | 🔴 High |
| veTokenomics | Stake → governance power | 🟡 Medium |
| Deflationary burns | Protocol revenue → buyback | 🟡 Medium |

**Slabiny:**
- ❌ Gaming/entertainment focus (ne enterprise)
- ❌ Spekulativní nature (86% down od ATH)
- ❌ Žádný trust/reputation systém
- ❌ Žádná dispute resolution

---

### 2.3 Fetch.ai / ASI Alliance

| | |
|---|---|
| **Website** | https://fetch.ai, https://superintelligence.io |
| **GitHub** | https://github.com/fetchai |
| **License** | Apache 2.0 |
| **Token** | FET ([CoinMarketCap](https://coinmarketcap.com/currencies/artificial-superintelligence-alliance/)) |

**Co to je:**
Merged entity (Fetch.ai + SingularityNET + Ocean Protocol + CUDOS). Enterprise-focused AI agent platform.

**Ověřené milníky:**

| Datum | Event | Zdroj |
|-------|-------|-------|
| 2024 | AGIX + OCEAN merge do FET | [Crypto.com](https://crypto.com/en/university/what-is-the-artificial-superintelligence-alliance) |
| Nov 2025 | "Claim Your Agent" brand protection launch | [BusinessWire](https://www.businesswire.com/news/home/20251119088395/en/) |
| Dec 2025 | První AI-to-AI platba přes Visa | [Fetch.ai Blog](https://fetch.ai/blog/world-s-first-ai-to-ai-payment-for-real-world-transactions) |
| Oct 2025 | Visa Trusted Agent Protocol | [Visa Investor Relations](https://investor.visa.com/news/news-details/2025/Visa-and-Partners-Complete-Secure-AI-Transactions-Setting-the-Stage-for-Mainstream-Adoption-in-2026/default.aspx) |

**Konkrétní příklad - AI-to-AI Visa platba:**

```
Use case: Autonomní rezervace večeře
Datum: 18. prosince 2025
Zdroj: fetch.ai/blog

Flow:
1. Tvůj Personal AI (ASI:One) → koordinuje s kamarádovým AI
2. Oba AI se dohodnou na restauraci
3. Rezervace přes OpenTable API
4. Platba přes Visa (dedicated AI wallet s limitem)
5. Vše proběhlo zatímco OBA uživatelé byli offline

Security:
- AI wallet s user-defined spending limits
- Temporary Visa credentials (nikdy se neukládají)
- On-chain USDC/FET jako backup
```

**Visa Trusted Agent Protocol (říjen 2025):**

```
┌─────────────────────────────────────────────────────────────┐
│              VISA TRUSTED AGENT PROTOCOL                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Problem: Jak merchant pozná legitimního AI agenta vs bot?  │
│                                                             │
│  Solution:                                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  1. Agent credentials (verified by Visa)             │   │
│  │  2. User authorization proof                         │   │
│  │  3. Spending limits enforcement                      │   │
│  │  4. Real-time fraud detection                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Partners: 10+ companies v pilotu                           │
│  Status: "Hundreds of secure transactions completed"        │
│  Source: Visa Investor Relations (Oct 2025)                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**"Claim Your Agent" - Brand Protection:**

```
URL: https://fetch.ai (announced Nov 2025)

Jak to funguje:
1. Značka (Nike, Hilton) zaregistruje verified namespace
2. Namespace: @nike/customer-support, @hilton/concierge
3. KYC/KYB verification
4. Ochrana proti knock-off agentům

Citát z CEO Humayun Sheikh:
"This is a Visa system. We're connecting it to the agent
and making sure there's trust building, a layer of security,
and a KYC element built in."
```

**Co ukrást:**

| Feature | Implementace | Priorita |
|---------|--------------|----------|
| Verified namespaces | @brand/agent-name | 🔴 High |
| Fiat integration | Visa/Mastercard rails | 🟡 Medium |
| Low-code builder | Agentverse visual editor | 🔴 High |
| AI wallet limits | User-defined spending caps | 🟡 Medium |

**Slabiny:**
- ❌ Komplexní, fragmentovaný ekosystém (4 merged projekty)
- ❌ Pomalý development
- ❌ Vysoká bariéra vstupu
- ❌ Token economics nejasné po merger

---

### 2.4 x402 Protocol

| | |
|---|---|
| **Website** | https://www.x402.org |
| **GitHub** | https://github.com/coinbase/x402 |
| **Whitepaper** | https://www.x402.org/x402-whitepaper.pdf |
| **License** | Open source |

**Co to je:**
Open payment standard od Coinbase pro HTTP micropayments. Revive HTTP 402 "Payment Required".

**Ověřené metriky:**

| Metrika | Hodnota | Zdroj |
|---------|---------|-------|
| Celkové platby | 100M+ za 6 měsíců | [The Block](https://www.theblock.co/post/382284/coinbase-incubated-x402-payments-protocol-built-for-ais-rolls-out-v2) |
| Cross-project tx | 15M+ | [DWF Labs](https://www.dwf-labs.com/research/inside-x402-how-a-forgotten-http-code-becomes-the-future-of-autonomous-payments) |
| Supported chains | Base, Solana, Polygon, Avalanche, Sui, Near | [x402.org](https://www.x402.org) |
| Foundation | Coinbase + Cloudflare (září 2025) | [Cloudflare Blog](https://blog.cloudflare.com/x402/) |

**V2 Features (září 2025):**

| Feature | Popis | Zdroj |
|---------|-------|-------|
| Streaming payments | Kontinuální platby, ne per-request | [The Block](https://www.theblock.co/post/382284) |
| Multi-asset | USDC, ETH, custom tokens v jednom flow | [The Block](https://www.theblock.co/post/382284) |
| Cloudflare integration | CDN-level payment enforcement | [Cloudflare Blog](https://blog.cloudflare.com/x402/) |
| Google AP2 | Agent Payments Protocol používá x402 | [DWF Labs](https://www.dwf-labs.com/research/inside-x402-how-a-forgotten-http-code-becomes-the-future-of-autonomous-payments) |

---

### 2.5 Developer Frameworks

#### ElizaOS

| | |
|---|---|
| **Website** | https://elizaos.ai |
| **GitHub** | https://github.com/elizaOS/eliza |
| **Docs** | https://docs.elizaos.ai |
| **License** | Open source |

**Klíčové features:**
- 90+ pluginů (Discord, Telegram, Ethereum, Solana, OpenAI, Anthropic...)
- Multi-chain: Chainlink CCIP integrace (Nov 2025)
- Model agnostic: OpenAI, Gemini, Anthropic, Llama, Grok

**Instalace:**
```bash
npx create-eliza-app my-agent
```

#### Coinbase AgentKit

| | |
|---|---|
| **Website** | https://www.coinbase.com/developer-platform/products/agentkit |
| **GitHub** | https://github.com/coinbase/agentkit |
| **Docs** | https://docs.cdp.coinbase.com/agent-kit/welcome |

**Q1 2025 Updates ([source](https://www.coinbase.com/developer-platform/discover/launches/agentkit-q1-update)):**
- Solana support (MTNDAO)
- Gasless transactions (CDP Smart Wallet)
- Built-in faucet pro Base Sepolia
- Smart contract deployment

**Quick start:**
```bash
npm create onchain-agent@latest
```

---

## 3. Open Source Status

| Projekt | License | Klíčové repos | Co je open |
|---------|---------|---------------|------------|
| **Olas** | MIT | [valory-xyz](https://github.com/valory-xyz) | Governance, registries, mech agents |
| **Virtuals** | Mixed | [Virtual-Protocol](https://github.com/Virtual-Protocol) | SDKs, některé kontrakty |
| **Fetch.ai** | Apache 2.0 | [fetchai](https://github.com/fetchai) | uAgents framework |
| **x402** | Open | [coinbase/x402](https://github.com/coinbase/x402) | Kompletní protokol |
| **ElizaOS** | Open | [elizaOS/eliza](https://github.com/elizaOS/eliza) | Kompletní framework |
| **AgentKit** | Open | [coinbase/agentkit](https://github.com/coinbase/agentkit) | Kompletní SDK |

**Závěr:** Většina konkurence je open source. AgentMe může:
1. Studovat jejich implementace
2. Forkovat užitečné části (s respektem k licencím)
3. Být kompatibilní (ne konkurovat na úrovni protokolu)

---

## 4. Feature Comparison Matrix

### 4.1 Core Features (ověřeno)

| Feature | AgentMe | Olas | Virtuals | Fetch.ai |
|---------|-----------|------|----------|----------|
| Agent Discovery | ✅ DHT + semantic | ✅ Marketplace | ❌ Manual | ✅ Agentverse |
| Trust/Reputation | ✅ On-chain | ❌ None | ❌ None | ⚠️ Basic |
| Micropayments | ✅ x402 | ✅ Crypto | ✅ Crypto | ✅ Crypto + Visa |
| Escrow | ✅ Smart contract | ❌ None | ❌ None | ⚠️ Basic |
| Dispute Resolution | ✅ 3-tier | ❌ None | ❌ None | ❌ None |
| Multi-chain | ❌ Base only | ✅ 9 chains | ✅ 3 chains | ✅ Multiple |
| Agent Tokenization | ❌ None | ❌ None | ✅ Full | ❌ None |
| Low-code Builder | ❌ None | ❌ None | ⚠️ Basic | ✅ Full |
| Enterprise Compliance | ⚠️ Planned | ❌ None | ❌ None | ✅ Partial |
| Fiat Payments | ❌ None | ❌ None | ❌ None | ✅ Visa |

### 4.2 Dispute Resolution (AgentMe unique)

AgentMe má jediný tiered dispute resolution systém na trhu:

| Tier | Částka | Mechanismus | Inspirace |
|------|--------|-------------|-----------|
| Auto | < $10 | Smart contract rules | - |
| AI-assisted | $10-$1000 | LLM arbitráž | - |
| Community | > $1000 | Kleros-style jury | [Kleros](https://kleros.io) - 900+ disputes, 800+ jurors |

**Kleros statistiky ([source](https://kleros.io)):**
- 900+ disputes resolved
- 150M PNK staked
- 350+ ETH paid to jurors
- 800+ active jurors

---

## 5. Cross-chain Messaging Options

Pro multi-chain support máme dvě hlavní možnosti:

### LayerZero vs Wormhole ([source](https://yellow.com/research/cross-chain-messaging-comparing-ibc-wormhole-layerzero-ccip-and-more))

| Aspect | LayerZero | Wormhole |
|--------|-----------|----------|
| **Architektura** | Ultra-Light Nodes (ULN) | 19 Guardian nodes |
| **Verifikace** | Oracle + Relayer (modular) | 13-of-19 multisig |
| **Trust model** | App-configurable | Fixed guardian set |
| **Speed** | Rychlejší | Pomalejší, ale bezpečnější |
| **Chains** | 30+ DVNs | 20+ chains |
| **Uniswap approval** | ❌ | ✅ Unconditional |
| **Messages processed** | N/A | 1B+ ([source](https://flashift.app/blog/wormhole-layerzero-and-axelar-the-future-of-cross-chain-messaging/)) |

**Doporučení:** Wormhole pro trustless security, LayerZero pro flexibilitu.

---

## 6. Prioritized Feature Roadmap

### 6.1 Phase 1: Competitive Parity (Q1 2026)

**Cíl:** Dosáhnout feature parity s Olas

| # | Feature | Reference impl | Effort | Impact |
|---|---------|----------------|--------|--------|
| 1 | Multi-chain | [Olas](https://github.com/valory-xyz) | 3 weeks | 🔥🔥🔥 |
| 2 | Marketplace UI | [Olas Mech](https://olas.network/mech-marketplace) | 2 weeks | 🔥🔥🔥 |
| 3 | Plugin system | [ElizaOS](https://github.com/elizaOS/eliza) | 2 weeks | 🔥🔥 |
| 4 | Streaming payments | [x402 V2](https://github.com/coinbase/x402) | 1 week | 🔥🔥 |

### 6.2 Phase 2: Differentiation (Q2 2026)

**Cíl:** Unikátní features, které konkurence nemá

| # | Feature | Reference impl | Effort | Impact |
|---|---------|----------------|--------|--------|
| 5 | Verified namespaces | [Fetch.ai "Claim Your Agent"](https://fetch.ai) | 2 weeks | 🔥🔥🔥 |
| 6 | Agent tokenization | [Virtuals](https://github.com/Virtual-Protocol/protocol-contracts) | 4 weeks | 🔥🔥🔥 |
| 7 | NFT-bound reputation | Original design | 2 weeks | 🔥🔥 |
| 8 | Low-code builder | [Fetch.ai Agentverse](https://agentverse.ai) | 6 weeks | 🔥🔥🔥 |

### 6.3 Phase 3: Enterprise (Q3 2026)

**Cíl:** Enterprise-grade features

| # | Feature | Reference | Effort | Impact |
|---|---------|-----------|--------|--------|
| 9 | HIPAA compliance | Original | 4 weeks | 🔥🔥🔥 |
| 10 | SOC2 certification | Original | 6 weeks | 🔥🔥🔥 |
| 11 | Fiat payments | [Visa TAP](https://investor.visa.com/news/news-details/2025/Visa-and-Partners-Complete-Secure-AI-Transactions-Setting-the-Stage-for-Mainstream-Adoption-in-2026/default.aspx) | 8 weeks | 🔥🔥 |

---

## 7. Technical Specs for Key Features

### 7.1 Agent Tokenization (inspired by Virtuals)

```solidity
// SPDX-License-Identifier: MIT
// Reference: https://github.com/Virtual-Protocol/protocol-contracts

contract AgentTokenFactory {
    // Launch fee: 100 MESH tokens (equivalent to Virtuals' 100 VIRTUAL)
    uint256 public constant LAUNCH_FEE = 100 * 10**18;

    // Bonding curve pro price discovery
    // Initial: 10% liquidity, 90% vested

    struct AgentToken {
        address tokenAddress;
        address agentDID;
        uint256 launchTime;
        bool verified;
    }

    // Revenue split (adjusted from Virtuals model)
    // 70% operator, 20% token holders, 10% protocol
}
```

### 7.2 Verified Namespace (inspired by Fetch.ai)

```solidity
// Reference: Fetch.ai "Claim Your Agent"

contract NamespaceRegistry {
    enum VerificationTier {
        Domain,    // DNS TXT record
        Business,  // KYB verification
        Compliance // SOC2/HIPAA
    }

    struct Namespace {
        string name;           // e.g., "@anthropic"
        address owner;
        VerificationTier tier;
        bytes32[] agentDIDs;   // Agents under this namespace
    }

    // @anthropic/claude-code → did:agentme:base:0x...
    function resolveAgent(string memory fullName)
        external view returns (bytes32 agentDID);
}
```

---

## 8. Competitive Advantages Summary

### Co AgentMe má, co ostatní nemají:

| Advantage | Popis | Konkurence |
|-----------|-------|------------|
| **Dispute Resolution** | 3-tier (auto, AI, Kleros-style) | Nikdo nemá |
| **Claude Code Bridge** | Native Anthropic integration | Unikátní |
| **Tiered Escrow** | Trust-based requirements | Nikdo nemá dynamic escrow |
| **Web-of-Trust** | Multi-hop endorsement graph | Olas/Virtuals nemají |

### Positioning:

```
                     HIGH TRUST
                         │
      ┌──────────────────┼──────────────────┐
      │                  │                  │
      │    ┌─────────────┴───┐              │
      │    │   AgentMe     │              │
      │    │   (Enterprise)  │              │
      │    └─────────────────┘              │
      │              ┌───────┐              │
      │              │Fetch.ai│             │
      │              └───────┘              │
      │                    ┌─────┐          │
      │                    │Olas │          │
      │                    └─────┘          │
      │                          ┌────────┐ │
      │                          │Virtuals│ │
      │                          └────────┘ │
      │                                     │
      └──────────────────┼──────────────────┘
     LOW                 │               HIGH
     SPECULATION         │         SPECULATION
```

---

## 9. Sources & References

### Primary Sources (verified)

| Source | URL | Data |
|--------|-----|------|
| Olas Q1 2025 Report | https://olas.network/blog/q-1 | Transaction stats |
| Olas Mech Marketplace | https://olas.network/mech-marketplace | Product info |
| Virtuals CoinMarketCap | https://coinmarketcap.com/currencies/virtual-protocol/ | Market data |
| Virtuals Messari | https://messari.io/report/understanding-virtuals-protocol-a-comprehensive-overview | Analysis |
| Fetch.ai AI Payment | https://fetch.ai/blog/world-s-first-ai-to-ai-payment-for-real-world-transactions | Visa integration |
| Visa TAP Announcement | https://investor.visa.com/news/news-details/2025/Visa-and-Partners-Complete-Secure-AI-Transactions-Setting-the-Stage-for-Mainstream-Adoption-in-2026/default.aspx | Official |
| x402 V2 Launch | https://www.theblock.co/post/382284/coinbase-incubated-x402-payments-protocol-built-for-ais-rolls-out-v2 | Protocol update |
| Cloudflare x402 | https://blog.cloudflare.com/x402/ | Foundation launch |
| Kleros Stats | https://kleros.io | Dispute data |
| Cross-chain Comparison | https://yellow.com/research/cross-chain-messaging-comparing-ibc-wormhole-layerzero-ccip-and-more | Technical |

### GitHub Repositories

| Project | Main Repo |
|---------|-----------|
| Olas | https://github.com/valory-xyz |
| Virtuals | https://github.com/Virtual-Protocol |
| Fetch.ai | https://github.com/fetchai |
| x402 | https://github.com/coinbase/x402 |
| ElizaOS | https://github.com/elizaOS/eliza |
| AgentKit | https://github.com/coinbase/agentkit |

---

## 10. Next Steps

1. [ ] Review a schválení tohoto dokumentu
2. [ ] Deep dive do Olas open-source kódu
3. [ ] PoC multi-chain s Wormhole
4. [ ] Design marketplace UI mockups
5. [ ] Evaluate Virtuals tokenization model pro AgentMe

---

*Document generated: 2026-02-02*
*Version: 0.2 (verified sources)*
*Author: Claude Code Analysis*
