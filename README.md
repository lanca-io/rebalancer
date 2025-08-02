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

### Manager Hierarchy and Dependencies

```
┌─────────────────────────────────────────────────────────────┐
│                    Infrastructure Layer                      │
├─────────────────┬───────────────────┬───────────────────────┤
│     Logger      │   HttpClient      │   RpcManager          │
│ (from operator) │ (from operator)   │ (from operator)       │
└─────────────────┴───────────────────┴───────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Core Management Layer                     │
├─────────────────┬───────────────────┬───────────────────────┤
│ DeploymentManager│ LancaNetworkManager│ ViemClientManager    │
│   (Custom)      │   (Custom)        │ (from operator)       │
└─────────────────┴───────────────────┴───────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Transaction Management Layer                 │
├─────────────────┬───────────────────┬───────────────────────┤
│   TxMonitor     │   TxReader        │   TxWriter            │
│ (from operator) │ (from operator)   │ (from operator)       │
└─────────────────┴───────────────────┴───────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Business Logic Layer                      │
├─────────────────┬───────────────────┬───────────────────────┤
│ BalanceManager  │  Rebalancer       │ OpportunityScorer     │
│   (Custom)      │   (Custom)        │   (Custom)            │
└─────────────────┴───────────────────┴───────────────────────┘
```

### Network Management Layer

**ConceroNetworkManager** (from operator-utils)
- **Responsibility**: Fetches and maintains the list of all Concero-supported networks
- **Behavior**: No automatic updates - only updates when explicitly triggered via `forceUpdate()`
- **Output**: Provides network configurations including chain IDs, RPC endpoints, and viem chains
- **Lifecycle**: Controlled entirely by LancaNetworkManager

**LancaNetworkManager** (custom implementation)
- **Responsibility**: Central coordinator for network lifecycle management
- **Key Behaviors**:
  - Controls the entire network update cycle via configurable intervals
  - Triggers ConceroNetworkManager updates on schedule
  - Filters networks to only include those with Lanca deployments (pools + tokens)
  - Manages whitelist/blacklist filtering
  - Serves as the single source of truth for active networks
  - Coordinates network changes across all dependent managers via NetworkUpdateListener pattern
- **Update Flow**: `forceUpdate() → filter by deployments → notify listeners`
- **Listeners**: RpcManager, ViemClientManager, BalanceManager, TxReader

### Deployment Management

**DeploymentManager** (custom implementation)
- **Responsibility**: Central source for all Lanca contract addresses
- **Key Behaviors**:
  - Fetches LBF pool and token contract addresses from remote environment files
  - Parses deployment patterns using regex:
    - Pool contracts: `/LBF_CHILD_POOL_(.+)/`, `/LBF_PARENT_POOL_(.+)/`
    - Token contracts: `/USDC_(.+)/`, `/IOU_(.+)/`
  - Supports localhost mode with hardcoded deployments for testing
  - Provides deployment lookups for other managers
- **Output**: Structured deployment object with pools, parentPool, USDC tokens, and IOU tokens
- **Lifecycle**: Initialized once during startup, can be updated via `updateDeployments()`

### Infrastructure Layer

**RpcManager** (from operator-utils)
- **Responsibility**: Manages RPC endpoints for each active network
- **Key Behaviors**:
  - Updates RPC lists when networks change via NetworkUpdateListener
  - Provides fallback RPC configurations
  - Uses Concero's RPC registry for reliable endpoints
- **Lifecycle**: Automatically updated when LancaNetworkManager triggers network changes

**ViemClientManager** (from operator-utils)
- **Responsibility**: Creates and manages Viem wallet and public clients
- **Key Behaviors**:
  - Generates wallet clients using `OPERATOR_PRIVATE_KEY`
  - Handles transaction signing and blockchain interactions
  - Updates clients when networks or RPCs change
- **Lifecycle**: Automatically updated via NetworkUpdateListener pattern

### Transaction Management

**TxReader** (from operator-utils)
- **Responsibility**: Sets up contract function watchers and reads blockchain data
- **Key Behaviors**:
  - Polls `getPoolData()` on each pool contract using `readContractWatcher`
  - Provides event and log reading capabilities
  - Uses configurable polling intervals
- **Dependencies**: Relies on LancaNetworkManager for active networks

**TxWriter** (from operator-utils)
- **Responsibility**: Handles transaction preparation and submission
- **Key Behaviors**:
  - Manages nonces via NonceManager
  - Handles gas estimation and transaction signing
  - Supports dry-run mode via `DRY_RUN` environment variable
- **Dependencies**: Uses ViemClientManager for client access

**TxMonitor** (from operator-utils)
- **Responsibility**: Tracks submitted transactions
- **Key Behaviors**:
  - Monitors transaction confirmations
  - Handles retries and failure recovery
  - Provides transaction status updates
- **Lifecycle**: Runs independently with configurable check intervals

### Business Logic Layer

**BalanceManager** (custom implementation)
- **Responsibility**: Tracks and manages token balances across all active networks
- **Key Behaviors**:
  - Monitors three balance types per network:
    - Native tokens (for gas fees)
    - USDC tokens (for filling deficits)
    - IOU tokens (received from deficit filling)
  - Uses TxReader's `readContractWatcher` for real-time balance updates
  - Provides allowance management for token approvals
  - Implements NetworkUpdateListener to respond to network changes
- **Update Mechanism**: Automatic via contract watchers + manual via `forceUpdate()`
- **Lifecycle**: Receives network updates from LancaNetworkManager

**OpportunityScorer** (custom implementation)
- **Responsibility**: Evaluates and scores rebalancing opportunities
- **Key Behaviors**:
  - Checks feasibility of opportunities (balances, gas, allowances)
  - Calculates scores based on urgency, cost, and opportunity type
  - Applies configurable minimum score thresholds
  - Provides detailed feasibility reasons for debugging
- **Scoring Factors**:
  - Base weights: fillDeficit (100), takeSurplus (100), bridgeIOU (40)
  - Urgency multipliers based on deficit/surplus ratios
  - Cost factors including gas and bridge fees
- **Dependencies**: Uses BalanceManager for balance checks, LancaNetworkManager for network access

**Rebalancer** (custom implementation)
- **Responsibility**: Implements core rebalancing logic and decision engine
- **Key Behaviors**:
  - Monitors pool states via `getPoolData()` calls using TxReader
  - Discovers rebalancing opportunities across three types:
    1. **Deficit filling**: Fill pools with insufficient USDC
    2. **Surplus redemption**: Redeem IOU for USDC from pools with excess
    3. **IOU bridging**: Move IOU tokens to networks with highest surplus
  - Makes decisions based on:
    - Deficit/surplus thresholds (configurable)
    - Available balances across networks
    - Net total allowance (risk management limit)
    - Opportunity scores from OpportunityScorer
  - Executes transactions via TxWriter
  - Tracks total USDC redeemed for net allowance calculations
- **Monitoring**: Sets up pool listeners using TxReader's `readContractWatcher`
- **Lifecycle**: Coordinates the entire rebalancing process from discovery to execution

## How It Works

### 1. Initialization Phase

The system follows a strict dependency order during initialization:

```
1. Logger → HttpClient → RpcManager (infrastructure setup)
2. ConceroNetworkManager (no auto-updates, controlled by LancaNetworkManager)
3. ViemClientManager (uses RpcManager for endpoints)
4. DeploymentManager (fetches all Lanca contracts)
5. LancaNetworkManager (central coordinator)
6. TxMonitor, TxReader, TxWriter (transaction infrastructure)
7. BalanceManager (depends on TxReader for watchers)
8. Rebalancer (depends on all above managers)
9. Rebalancer.setupPoolListeners() (starts monitoring)
```

### 2. Network Update Cycle

LancaNetworkManager orchestrates the entire update flow:

```
Every 5 minutes (configurable via LANCA_NETWORK_UPDATE_INTERVAL_MS):
├── Trigger ConceroNetworkManager.forceUpdate()
├── Fetch latest deployments via DeploymentManager.updateDeployments()
├── Filter networks:
│   ├── Must have Lanca deployments (pools + tokens)
│   ├── Must not be blacklisted
│   ├── Must be whitelisted (if specified)
│   └── Must include parent pool network
├── If networks changed:
│   ├── RpcManager.updateNetworks() → Update RPC endpoints
│   ├── ViemClientManager.updateClients() → Update viem clients
│   ├── BalanceManager.onNetworksUpdated() → Update balance tracking
│   └── TxReader.updateNetworks() → Update contract watchers
└── Continue monitoring unchanged networks
```

### 3. Balance Monitoring

BalanceManager uses TxReader's contract watchers for real-time updates:

```
For each active network:
├── Create USDC balance watcher (balanceOf function)
├── Create IOU balance watcher (balanceOf function)
├── Poll native balances periodically
├── Update internal state on balance changes
└── Provide balance queries to Rebalancer
```

### 4. Pool Monitoring

Rebalancer sets up dedicated pool listeners via TxReader:

```
For each network with Lanca deployments:
├── Parent pool: Monitor via getPoolData() calls
├── Child pools: Monitor each via getPoolData() calls
├── Receive (deficit, surplus) values
├── Update internal pool state
└── Trigger opportunity discovery on each update
```

### 5. Opportunity Discovery and Scoring

Rebalancer implements a three-tier opportunity discovery system:

#### Tier 1: Local Opportunities (Highest Priority)
```
Deficit Filling:
├── Check each network's pool deficit
├── Verify USDC balance >= deficit amount
├── Check (totalIOU - totalRedeemed) < NET_TOTAL_ALLOWANCE
├── Ensure native balance for gas
└── Score based on urgency (deficit ratio)

Surplus Redemption:
├── Check each network's pool surplus
├── Verify IOU balance >= surplus amount
├── Ensure native balance for gas
└── Score based on urgency (surplus ratio)
```

#### Tier 2: Cross-Chain Opportunities (Lower Priority)
```
IOU Bridging:
├── Identify networks with IOU but no local opportunities
├── Find network with highest surplus
├── Verify IOU balance on source network
├── Ensure native balances on both networks
└── Score based on bridge cost vs opportunity value
```

#### Tier 3: Scoring and Filtering
```
For each discovered opportunity:
├── Check feasibility via BalanceManager
├── Calculate score via OpportunityScorer
├── Filter by minimum score threshold
├── Sort by score (highest first)
└── Execute top opportunities
```

### 6. Transaction Execution Flow

When opportunities are selected for execution:

```
1. **Pre-execution checks**:
   ├── Verify allowances via BalanceManager.ensureAllowance()
   ├── Confirm balances haven't changed
   ├── Check gas estimates

2. **Transaction preparation**:
   ├── Select appropriate contract function
   ├── Prepare transaction parameters
   ├── Set gas limits and nonce

3. **Execution**:
   ├── Submit via TxWriter
   ├── Monitor via TxMonitor
   ├── Handle failures with retries

4. **Post-execution**:
   ├── Update internal counters (totalRedeemedUsdc)
   ├── Refresh balances via BalanceManager
   ├── Log transaction details
```

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

# Rebalancing Parameters
REBALANCER_DEFICIT_THRESHOLD=10          # Min deficit to fill (USDC)
REBALANCER_SURPLUS_THRESHOLD=10          # Min surplus to redeem (USDC)
REBALANCER_NET_TOTAL_ALLOWANCE=1000000   # Max IOU exposure (USDC)
REBALANCER_MIN_ALLOWANCE_USDC=1000       # Min USDC allowance
REBALANCER_MIN_ALLOWANCE_IOU=1000        # Min IOU allowance
OPPORTUNITY_SCORER_MIN_SCORE=50          # Min opportunity score

# Execution Mode
DRY_RUN=false                           # Simulation mode
LOG_LEVEL_DEFAULT=info                  # Logging level
```

### Network Filtering

Networks are included based on:
1. Presence in ConceroNetworkManager
2. Having LBF pool deployments (both pools and tokens)
3. Not being in the blacklist (IGNORED_NETWORK_IDS)
4. Being in the whitelist (WHITELISTED_NETWORK_IDS) if specified
5. Including the parent pool network regardless of other filters

## Risk Management

### Net Total Allowance

The rebalancer implements a risk limit through `NET_TOTAL_ALLOWANCE`:
- Tracks total IOU tokens held across all chains
- Subtracts total USDC redeemed via `totalRedeemedUsdc` counter
- Prevents filling deficits if limit exceeded
- Protects against overexposure to IOU tokens
- Calculated as: `netAllowance = NET_TOTAL_ALLOWANCE - (totalIOU - totalRedeemed)`

### Gas Management

Before any transaction:
- Verifies sufficient native token balance via BalanceManager.hasNativeBalance()
- Prevents failed transactions due to gas
- Maintains minimum gas reserves per chain
- Uses BalanceManager for real-time balance checking

### Balance Verification

All operations verify:
- Token balances before transfers via BalanceManager queries
- Deficit/surplus amounts before actions via pool data
- Cross-chain balance consistency across networks
- Allowance requirements via BalanceManager.ensureAllowance()
- Gas requirements via native balance checks

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

### Manager-Specific Debugging

Each manager provides detailed logging at different levels:
- **LancaNetworkManager**: Network changes, deployment updates, listener notifications
- **DeploymentManager**: Contract discovery, parsing results, localhost fallback
- **BalanceManager**: Balance changes, allowance updates, watcher lifecycle
- **Rebalancer**: Opportunity discovery, scoring results, transaction execution
- **OpportunityScorer**: Feasibility checks, score calculations, filtering results

## Dependencies

- **@concero/operator-utils**: Core infrastructure and utilities
- **viem**: Ethereum interaction library
- **TypeScript**: Type-safe development
- **Node.js 18+**: Runtime environment

Note: Requires a modified version of operator-utils with ConceroNetworkManager changes. See [docs/operator-utils-changes.md](docs/operator-utils-changes.md).

## License

See [LICENSE](LICENSE) file for details.
