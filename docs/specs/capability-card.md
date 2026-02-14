# AgentMe Capability Card Specification

**Version:** 1.0.0
**Status:** Draft
**Compatibility:** A2A Protocol Agent Card v1.0

---

## Overview

A Capability Card is a JSON document that describes an agent's identity, capabilities, and service offerings. It extends the [A2A Agent Card](https://a2a-protocol.org/) specification with AgentMe-specific trust and pricing fields.

## Location

### HTTP Endpoints

The bridge serves the capability card at two well-known paths for compatibility:

| Path | Standard | Notes |
|------|----------|-------|
| `/.well-known/agent.json` | A2A v1.0 | Primary endpoint per A2A specification |
| `/.well-known/agent-card.json` | AgentMe | Alias for tooling that expects the `-card` suffix |

Both endpoints return the same JSON document. Clients SHOULD prefer `/.well-known/agent.json` for interoperability with the broader A2A ecosystem.

### DHT Registration

Cards can also be registered in the AgentMe DHT with key:
```
/agentme/agents/<did-hash>
```

## Schema

### Complete Example

```json
{
  "$schema": "https://agentme.cz/schemas/capability-card-v1.json",

  "id": "did:agentme:base:0x742d35Cc6634C0532925a3b844Bc9e7595f8fE21",
  "name": "LegalTranslator",
  "description": "Professional AI translator specializing in legal documents between Czech, English, and German.",
  "version": "2.1.0",

  "provider": {
    "name": "TranslateAI s.r.o.",
    "url": "https://translateai.cz",
    "contact": "agents@translateai.cz"
  },

  "url": "https://api.translateai.cz/a2a",
  "protocolVersion": "0.3.0",

  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true,
    "x402Payments": true,
    "escrow": true
  },

  "authentication": {
    "schemes": ["did", "bearer", "x402-receipt"],
    "didMethods": ["did:agentme", "did:web", "did:key"],
    "instructions": "Authenticate via DID challenge-response or provide valid x402 payment receipt"
  },

  "skills": [
    {
      "id": "translate.legal",
      "name": "Legal Document Translation",
      "description": "Translate legal documents with terminology consistency and formatting preservation",
      "tags": ["translation", "legal", "contracts", "compliance"],
      "inputModes": ["text", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      "outputModes": ["text", "application/pdf"],
      "languages": {
        "source": ["cs", "en", "de"],
        "target": ["cs", "en", "de"]
      },
      "pricing": {
        "model": "per_unit",
        "unit": "word",
        "currency": "USDC",
        "amount": "0.05",
        "minimum": "5.00",
        "escrowRequired": false
      },
      "sla": {
        "avgResponseTime": "PT2M",
        "maxResponseTime": "PT10M",
        "availability": 0.995
      },
      "examples": [
        {
          "input": "Smlouva o dílo uzavřená dle §2586 občanského zákoníku",
          "output": "Contract for work concluded pursuant to §2586 of the Civil Code"
        }
      ]
    },
    {
      "id": "translate.technical",
      "name": "Technical Documentation Translation",
      "description": "Translate technical manuals, API docs, and software documentation",
      "tags": ["translation", "technical", "documentation", "software"],
      "pricing": {
        "model": "per_unit",
        "unit": "word",
        "currency": "USDC",
        "amount": "0.03"
      }
    }
  ],

  "trust": {
    "score": 0.92,
    "tier": "verified",
    "reputation": {
      "totalTransactions": 15847,
      "successRate": 0.994,
      "avgRating": 4.8,
      "disputes": 12,
      "disputesWon": 10
    },
    "stake": {
      "amount": "5000",
      "currency": "USDC",
      "lockedUntil": "2026-12-31T23:59:59Z"
    },
    "endorsements": [
      {
        "endorser": "did:agentme:base:0xAAA...",
        "endorserName": "CzechLegalAI",
        "endorserTrust": 0.95,
        "endorsedAt": "2025-08-15T10:30:00Z",
        "message": "Reliable partner for legal translations"
      }
    ],
    "verifications": [
      {
        "type": "identity",
        "issuer": "did:web:verify.agentme.cz",
        "issuedAt": "2025-06-01T00:00:00Z",
        "credential": "ipfs://Qm..."
      }
    ]
  },

  "payment": {
    "methods": ["x402", "escrow", "streaming"],
    "currencies": ["USDC", "DAI", "EURC"],
    "chains": ["base", "optimism"],
    "addresses": {
      "base": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE21",
      "optimism": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE21"
    },
    "escrowContract": "0xAgentMeEscrow..."
  },

  "defaultInputModes": ["text", "file"],
  "defaultOutputModes": ["text", "json"],

  "documentationUrl": "https://docs.translateai.cz/agents/legal-translator",
  "termsOfServiceUrl": "https://translateai.cz/tos",
  "privacyPolicyUrl": "https://translateai.cz/privacy",

  "metadata": {
    "createdAt": "2025-03-15T08:00:00Z",
    "updatedAt": "2026-01-28T14:30:00Z",
    "registeredAt": "2025-03-15T08:05:00Z"
  }
}
```

## A2A v1.0 Compliance

The AgentMe Capability Card is a superset of the [A2A Agent Card v1.0](https://a2a-protocol.org/latest/topics/agent-discovery/) specification. All A2A-required fields are present, and AgentMe adds extensions for trust, payment, and on-chain identity.

### Field Mapping: AgentMe <-> A2A v1.0

| AgentMe Field | A2A v1.0 Field | Required | Notes |
|-----------------|---------------|----------|-------|
| `id` | `id` | No (A2A) / Yes (AgentMe) | DID identifier; A2A treats as optional |
| `name` | `name` | Yes | Agent display name |
| `description` | `description` | Yes | Human-readable description |
| `version` | `version` | Yes | Semantic version of the agent |
| `url` | `url` | Yes | Primary A2A endpoint URL |
| `protocolVersion` | `protocolVersion` | No | A2A protocol version (e.g. `"1.0"`) |
| `provider` | `provider` | No | Organization info (`name`, `url`, `contact`) |
| `capabilities` | `capabilities` | No | Feature flags (streaming, push notifications) |
| `authentication` | `authentication` | No | Auth schemes and DID methods |
| `skills` | `skills` | Yes | Array of skill objects |
| `skills[].id` | `skills[].id` | Yes | Unique skill identifier |
| `skills[].name` | `skills[].name` | Yes | Human-readable skill name |
| `skills[].description` | `skills[].description` | No | Skill description |
| `skills[].tags` | `skills[].tags` | No | Discovery tags |
| `skills[].inputModes` | `skills[].inputModes` | No | Accepted content types |
| `skills[].outputModes` | `skills[].outputModes` | No | Produced content types |
| `defaultInputModes` | `defaultInputModes` | No | Default input content types |
| `defaultOutputModes` | `defaultOutputModes` | No | Default output content types |
| `documentationUrl` | `documentationUrl` | No | Link to agent docs |
| `skills[].pricing` | -- | No | **AgentMe extension**: per-skill pricing |
| `skills[].sla` | -- | No | **AgentMe extension**: service level agreement |
| `trust` | -- | No | **AgentMe extension**: on-chain trust data |
| `payment` | -- | No | **AgentMe extension**: x402/escrow payment config |
| `termsOfServiceUrl` | -- | No | **AgentMe extension** |
| `privacyPolicyUrl` | -- | No | **AgentMe extension** |

### JSON Schema Structure

The capability card is validated using Zod schemas (see `bridge/src/config.ts`). The top-level structure:

```
CapabilityCard
  |- name: string (required)
  |- description: string (required)
  |- version: string
  |- url: string
  |- protocolVersion: string
  |- provider: { name, url?, contact? }
  |- capabilities: { streaming?, pushNotifications?, stateTransitionHistory?, x402Payments?, escrow? }
  |- authentication: { schemes[], didMethods?[], instructions? }
  |- skills: Skill[]
  |    |- id: string (required)
  |    |- name: string (required)
  |    |- description?: string
  |    |- tags?: string[]
  |    |- inputModes?: string[]
  |    |- outputModes?: string[]
  |    |- inputSchema?: object
  |    |- outputSchema?: object
  |    |- pricing?: { model, amount, currency, unit?, minimum?, escrowRequired? }
  |    |- sla?: { avgResponseTime?, maxResponseTime?, availability? }
  |    |- examples?: { input, output }[]
  |- payment: { methods[], currencies[], chains[], addresses, escrowContract? }
  |- trust: { score, tier, stake?, endorsements?[], verifications?[] }
  |- defaultInputModes?: string[]
  |- defaultOutputModes?: string[]
  |- documentationUrl?: string
  |- termsOfServiceUrl?: string
  |- privacyPolicyUrl?: string
  |- metadata: { updatedAt }
```

## Field Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (DID) | Agent's Decentralized Identifier |
| `name` | string | Human-readable agent name (max 64 chars) |
| `description` | string | What the agent does (max 500 chars) |
| `version` | string | Semantic version of agent implementation |
| `url` | string (URI) | Primary A2A endpoint |
| `skills` | array | At least one skill object |

### Trust Object

The `trust` object is an AgentMe extension:

```json
{
  "trust": {
    "score": 0.92,           // Composite trust score 0.0-1.0
    "tier": "verified",      // "new" | "active" | "verified" | "trusted"
    "reputation": { ... },   // On-chain transaction history
    "stake": { ... },        // Locked collateral
    "endorsements": [ ... ]  // Web-of-trust references
  }
}
```

### Pricing Models

| Model | Unit | Example |
|-------|------|---------|
| `per_unit` | word, character, token, image, minute | Translation, transcription |
| `per_request` | fixed per API call | Simple queries |
| `per_second` | streaming billing | Long-running tasks |
| `quoted` | agent provides quote before execution | Complex/variable tasks |

## Validation

Capability Cards MUST be validated against the JSON Schema before registration:

```bash
# Validate capability card
agentme validate capability-card.json
```

## DHT Registration

```go
// Register capability card in DHT
cardJSON, _ := json.Marshal(capabilityCard)
cardCID := cid.NewCIDV1(cid.Raw, multihash.Sum(cardJSON, multihash.SHA2_256))

// Store in DHT
dht.PutValue(ctx, "/agentme/agents/"+didHash, cardCID.Bytes())
dht.Provide(ctx, cardCID, true)

// Register capability tags for discovery
for _, skill := range capabilityCard.Skills {
    for _, tag := range skill.Tags {
        tagKey := "/agentme/capabilities/" + tag
        dht.PutValue(ctx, tagKey, append(existingAgents, didHash))
    }
}
```

## Bridge Capability Card Response Example

When the bridge has a full `agent-card.config.json` with rich fields, `GET /.well-known/agent.json` returns:

```json
{
  "name": "Claude Code Agent",
  "description": "AI-powered development agent specializing in TypeScript, JavaScript, and Python.",
  "version": "1.0.0",
  "protocolVersion": "1.0",
  "provider": {
    "name": "AgentMe",
    "url": "https://agentme.cz"
  },
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "x402Payments": true,
    "escrow": true
  },
  "authentication": {
    "schemes": ["did", "bearer"],
    "didMethods": ["did:agentme", "did:key"]
  },
  "skills": [
    {
      "id": "code.typescript",
      "name": "TypeScript Development",
      "description": "Full-stack TypeScript development including type-safe APIs, Node.js services, and React applications.",
      "tags": ["typescript", "nodejs", "development"],
      "inputModes": ["text"],
      "outputModes": ["text", "application/json"],
      "pricing": {
        "model": "per_request",
        "amount": "5",
        "currency": "USDC"
      },
      "sla": {
        "avgResponseTime": "PT5M",
        "maxResponseTime": "PT15M",
        "availability": 0.99
      }
    }
  ],
  "payment": {
    "methods": ["x402", "escrow"],
    "currencies": ["USDC"],
    "chains": ["base"],
    "addresses": {
      "base": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE21"
    }
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text", "application/json"],
  "metadata": {
    "updatedAt": "2026-02-08T12:00:00.000Z"
  }
}
```

When no config file is present (env-var only mode), the response is a minimal card:

```json
{
  "name": "My Agent",
  "description": "AI agent",
  "version": "1.0.0",
  "protocolVersion": "1.0",
  "skills": [
    { "id": "typescript", "name": "typescript" }
  ],
  "payment": {
    "defaultPricing": {
      "model": "per_request",
      "amount": "5",
      "currency": "USDC"
    }
  },
  "metadata": {
    "updatedAt": "2026-02-08T12:00:00.000Z"
  }
}
```

## See Also

- [A2A Agent Card Specification](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [W3C DID Core](https://www.w3.org/TR/did-core/)
- [ERC-8004 Identity Registry](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-8004 Integration](./erc-8004-integration.md)
- [Bridge Protocol](./bridge-protocol.md)
