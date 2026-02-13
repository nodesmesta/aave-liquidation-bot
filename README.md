# Aave V3 Liquidation Bot

<p align="center">
  <img src="nodesemesta/nodesemesta.png" alt="Nodesemesta" width="200">
</p>

<p align="center">
  <strong>Automated liquidation bot for Aave V3 on Base Network</strong>
</p>

---

## Features

- Event-driven liquidation detection via Chainlink WebSocket
- Aave V3 protocol compliance (close factor, health factor, dust prevention)
- Flashblocks integration for fast execution
- Receipt polling with 100ms interval and 5s timeout
- Multi-user sequential liquidation with atomic transactions
- Comprehensive error handling and circuit breaker

## Quick Start

### Prerequisites

- Node.js v18+
- Foundry (for smart contracts)
- RPC provider with WebSocket support
- Aave V3 Subgraph API key

### Installation

```bash
git clone https://github.com/nodesemesta/aave-liquidation-bot.git
cd aave-liquidation-bot
npm install
git submodule update --init --recursive
forge build
npx hardhat compile
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your settings
```

### Run

```bash
npm run dev          # Development mode
npm run start        # Production mode
npm run test         # Run tests
```

## How It Works

### Liquidation Flow

1. **Detection**: Monitor price feeds via Chainlink WebSocket
2. **Identify**: Find users with health factor (HF) < 1.0
3. **Calculate**: Determine optimal liquidation amount respecting close factor
4. **Execute**: Broadcast TX via Flashblocks, poll receipt every 100ms
5. **Flashloan**: Use flashloan to cover debt without capital
6. **Swap**: Exchange collateral for debt asset via Uniswap V3
7. **Profit**: Keep liquidation bonus minus gas and flashloan fee

### Key Concepts

**Health Factor (HF):** `HF = (Total Collateral × Liquidation Threshold) / Total Debt`
- HF > 1.0: Safe position
- HF = 1.0: Critical (liquidation threshold)
- HF < 1.0: Liquidatable

**Close Factor:** Max percentage of debt that can be liquidated
- If HF >= 0.95: 50% max
- If HF < 0.95: 100% max (full liquidation allowed)

**Dust Prevention:** Aave prevents positions below $1 USD
- Bot calculates if liquidation would leave dust
- Adjusts amount automatically or skips if impossible

**Flashblocks:** Base Network preconfirmation service
- Faster TX broadcast and confirmation
- 200ms preconfirmation window
- Three-client architecture: walletClient and publicClient on Flashblocks, rpcPublicClient on public RPC for gas estimation

## Architecture

**Service Breakdown:**

| Service | Purpose |
|---------|---------|
| PriceOracle | Monitor Chainlink price feeds (WebSocket) |
| HealthChecker | Fetch user health factors from Aave |
| SubgraphService | Discover liquidatable users |
| OptimizedLiquidationService | Calculate optimal liquidation params with dust prevention |
| LiquidationExecutor | Execute TX and poll receipt (100ms interval, 5s timeout) |
| UserPool | Cache of at-risk users |

**Execution Strategy:**
- Sequential: Execute one user, restart for fresh state, process next
- Trade-off: Lower throughput, higher reliability and safety
- Nonce management: Simple sequential, no parallel complexity

## Configuration

**Key Parameters:**

```typescript
HIGH_RISK_HF_THRESHOLD = 1.03    // Early detection threshold
SAFE_HF_THRESHOLD = 1.1          // Cache removal threshold  
MIN_LIQUIDATION_VALUE_USD = 100  // Minimum liquidation opportunity
FIXED_GAS_LIMIT = 920,000        // TX gas allowance
```

## Testing

```bash
# Unit tests
forge test -vvv

# Integration tests
npm run test:integration

# Gas report
forge test --gas-report
```

## Security

- Private keys stored in `.env` (never commit)
- Comprehensive parameter validation
- Nonce management to prevent replay attacks
- Health factor verification before liquidation
- Circuit breaker for consecutive failures

## FAQ

**Q: How much capital is needed?**
A: ETH for gas only. Bot uses flashloans so large capital is not required.

**Q: What profit can I expect?**
A: Typically $10-500 per liquidation depending on market conditions and competition.

**Q: Does it work on other networks?**
A: Yes, update config with RPC and contract addresses for any EVM chain with Aave V3.

**Q: How to add new features?**
A: Follow service architecture. Tests required for changes. See Contributing guidelines.

## Contributing

1. Fork repository
2. Create feature branch: `git checkout -b feature/name`
3. Commit changes: `git commit -m 'Add feature'`
4. Push branch: `git push origin feature/name`
5. Open Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Connect

- GitHub: [nodesemesta](https://github.com/nodesemesta)
- Discord: [nodesemesta](https://discord.com/users/760709262694416435)
- Twitter: [@nodesemesta](https://twitter.com/nodesemesta)
- Email: [nodesemesta@gmail.com](mailto:nodesemesta@gmail.com)

## Support Research

If you find this project useful, consider supporting development:

Ethereum: `0x04898c077eb5f6e3dc5f6086cd96ceeed523cd81`

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/nodesemesta">Nodesemesta</a>
</p>

<p align="center">
  <sub>Built for Base Network • Powered by Aave V3 • Optimized for Performance</sub>
</p>
