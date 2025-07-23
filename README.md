# Lanca Rebalancer

An automated cross-chain liquidity management system for Lanca's Liquidity Bridging Framework (LBF) pools.

## Overview

The Lanca Rebalancer is a sophisticated arbitrage and liquidity management bot that monitors LBF pool states across multiple blockchain networks. It automatically rebalances liquidity by filling deficits in exchange for IOU tokens, which can then be bridged across chains and redeemed for USDC at a 1:1 ratio from pools with surplus.

### Core Operations

1. **Deficit Filling**: When a pool has insufficient USDC liquidity, the rebalancer fills the deficit using its USDC reserves and receives IOU tokens
2. **IOU Bridging**: Strategically moves IOU tokens across chains to locations with the highest surplus for optimal redemption
3. **Surplus Redemption**: Exchanges IOU tokens for USDC from pools with excess liquidity

The rebalancer earns profit through IOU premium fees charged when filling deficits, creating a sustainable incentive mechanism for maintaining cross-chain liquidity.

## Architecture

The system follows a modular, manager-based architecture built on top of the `@concero/operator-utils` library:

### Network Management Layer

```
┌─────────────────────────┐
│  ConceroNetworkManager  │ ◄── Fetches all Concero-supported networks
└───────────┬─────────────┘     (no automatic updates)
            │
            ▼
┌─────────────────────────┐
│   LancaNetworkManager   │ ◄── Controls update cycles
└───────────┬─────────────┘     Filters by deployments
            │                   Manages all listeners
            ▼
    Active Networks List
```

**ConceroNetworkManager** (from operator-utils)
- Fetches and maintains the list of all Concero-supported networks
- No automatic updates - only updates when explicitly triggered via `forceUpdate()`
- Provides network configurations including chain IDs, RPC endpoints, and viem chains

**LancaNetworkManager** (custom implementation)
- Controls the entire network update lifecycle
- Triggers ConceroNetworkManager updates on a configurable schedule
- Filters networks to only include those with Lanca deployments
- Acts as the central coordinator for all network-aware components
- Manages update listeners and cascades network changes throughout the system

### Deployment Management

**DeploymentManager**
- Fetches LBF pool and token contract addresses from environment files
- Parses deployment patterns:
  - Pool contracts: `LBF_CHILD_POOL_ETHEREUM`, `LBF_PARENT_POOL_ARBITRUM`
  - Token contracts: `USDC_ETHEREUM`, `IOU_ETHEREUM`
- Provides deployment lookups for other managers

### Infrastructure Layer

**RpcManager** (from operator-utils)
- Manages RPC endpoints for each active network
- Updates RPC lists when networks change
- Provides fallback RPC configurations

**ViemClientManager** (from operator-utils)
- Creates and manages Viem wallet and public clients
- Handles transaction signing and blockchain interactions
- Updates clients when networks or RPCs change

### Business Logic Layer

**BalanceManager**
- Tracks three types of balances per network:
  - Native tokens (for gas fees)
  - USDC tokens (for filling deficits)
  - IOU tokens (received from deficit filling)
- Updates balances periodically and on-demand
- Provides balance aggregation methods

**Rebalancer**
- Implements core rebalancing logic
- Monitors pool states via `getRebalancerData()` calls
- Makes decisions based on:
  - Deficit/surplus thresholds
  - Available balances
  - Net total allowance (risk management)
- Executes rebalancing transactions

### Transaction Management

**TxReader** (from operator-utils)
- Sets up contract function watchers
- Polls `getRebalancerData()` on each pool
- Provides event and log reading capabilities

**TxWriter** (from operator-utils)
- Handles transaction preparation and submission
- Manages nonces and gas estimation
- Supports dry-run mode for testing

**TxMonitor** (from operator-utils)
- Tracks submitted transactions
- Handles confirmations and retries
- Provides transaction status updates

## How It Works

### 1. Initialization Phase

```
1. Load configuration from environment
2. Initialize ConceroNetworkManager
3. Initialize infrastructure managers (RPC, Viem)
4. Initialize DeploymentManager
5. Initialize LancaNetworkManager
6. LancaNetworkManager triggers initial network fetch
7. Filter networks by deployment availability
8. Initialize BalanceManager with active networks
9. Initialize transaction managers
10. Initialize Rebalancer business logic
11. Set up pool monitoring subscriptions
```

### 2. Update Cycle

The LancaNetworkManager orchestrates periodic updates:

```
Every 5 minutes (configurable):
├── Trigger ConceroNetworkManager.forceUpdate()
├── Fetch latest deployments
├── Filter networks with Lanca deployments
├── If networks changed:
│   ├── Notify RpcManager → Update RPC endpoints
│   ├── Notify ViemClientManager → Update clients
│   └── Notify BalanceManager → Update balance tracking
└── Continue monitoring
```

### 3. Pool Monitoring

For each active network with deployments:

```
Every 30 seconds (configurable):
├── Call getRebalancerData() on pool contract
├── Receive (deficit, surplus) values
├── Update internal pool state
└── Trigger rebalancing opportunity check
```

### 4. Decision Engine

When pool data updates, the rebalancer evaluates opportunities:

#### Deficit Filling Decision
```
IF pool.deficit > DEFICIT_THRESHOLD
AND balance[network].usdc > 0
AND (totalIOU - totalRedeemed) < NET_TOTAL_ALLOWANCE
AND balance[network].native > 0 (for gas)
THEN → Fill deficit with available USDC
```

#### IOU Bridging Decision
```
FOR each network with IOU balance:
  Find network with highest surplus
  IF surplus > SURPLUS_THRESHOLD
  AND source has native gas
  THEN → Bridge IOU to high-surplus network
```

#### Surplus Redemption Decision
```
IF pool.surplus > SURPLUS_THRESHOLD
AND balance[network].iou > 0
AND balance[network].native > 0 (for gas)
THEN → Redeem IOU for USDC
```

### 5. Transaction Execution

When opportunities are identified:

1. **Prepare Transaction**: Create contract call with appropriate parameters
2. **Submit Transaction**: Sign and broadcast to the network
3. **Monitor Execution**: Track confirmation and handle failures
4. **Update State**: Reflect changes in internal balances and counters

## Configuration

### Environment Variables

```bash
# Network Mode
NETWORK_MODE=testnet                     # mainnet, testnet, localhost

# Operator Configuration
OPERATOR_ADDRESS=0x...                   # Wallet address
OPERATOR_PRIVATE_KEY=...                 # Private key (no 0x prefix)

# Deployment Sources
LANCA_POOL_DEPLOYMENTS_URL=https://...   # Pool contracts env file
LANCA_TOKEN_DEPLOYMENTS_URL=https://...  # Token contracts env file

# Update Intervals
LANCA_NETWORK_UPDATE_INTERVAL_MS=300000  # Network updates (5 min)
BALANCE_UPDATE_INTERVAL_MS=60000         # Balance updates (1 min)
REBALANCER_CHECK_INTERVAL_MS=30000       # Pool checks (30 sec)

# Rebalancing Parameters
DEFICIT_THRESHOLD=10                     # Min deficit to fill (USDC)
SURPLUS_THRESHOLD=10                     # Min surplus to redeem (USDC)
NET_TOTAL_ALLOWANCE=1000000             # Max IOU exposure (USDC)

# Execution Mode
DRY_RUN=false                           # Simulation mode
```

### Network Filtering

Networks are included based on:
1. Presence in ConceroNetworkManager
2. Having LBF pool deployments
3. Not being in the blacklist
4. Being in the whitelist (if specified)

## Risk Management

### Net Total Allowance

The rebalancer implements a risk limit through `NET_TOTAL_ALLOWANCE`:
- Tracks total IOU tokens held across all chains
- Subtracts total USDC redeemed
- Prevents filling deficits if limit exceeded
- Protects against overexposure to IOU tokens

### Gas Management

Before any transaction:
- Verifies sufficient native token balance
- Prevents failed transactions due to gas
- Maintains minimum gas reserves per chain

### Balance Verification

All operations verify:
- Token balances before transfers
- Deficit/surplus amounts before actions
- Cross-chain balance consistency

## Monitoring and Logging

The system provides comprehensive logging:
- Network updates and changes
- Deployment discoveries
- Balance updates
- Pool state changes
- Rebalancing decisions
- Transaction submissions and results

Logs are stored with:
- Automatic rotation (20MB max size)
- 7-day retention
- Configurable log levels per component

## Development

### Adding New Features

1. **New Managers**: Extend `ManagerBase` and implement required interfaces
2. **Network Listeners**: Implement `NetworkUpdateListener` for network-aware components
3. **Custom Logic**: Add to Rebalancer or create specialized managers

### Testing

```bash
# Dry run mode - simulates without executing
DRY_RUN=true npm start

# Debug logging
LOG_LEVEL_DEFAULT=debug npm start

# Component-specific logging
LOG_LEVELS_GRANULAR=Rebalancer:debug,LancaNetworkManager:info npm start
```

## Dependencies

- **@concero/operator-utils**: Core infrastructure and utilities
- **viem**: Ethereum interaction library
- **TypeScript**: Type-safe development
- **Node.js 18+**: Runtime environment

Note: Requires a modified version of operator-utils with ConceroNetworkManager changes. See [docs/operator-utils-changes.md](docs/operator-utils-changes.md).

## License

See [LICENSE](LICENSE) file for details.