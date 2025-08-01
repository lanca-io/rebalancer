import { ManagerBase } from '@concero/operator-utils';
import type { ConceroNetwork } from '@concero/operator-utils/src/types/ConceroNetwork';
import type { LoggerInterface } from '@concero/operator-utils/src/types/LoggerInterface';
import type {
  ITxReader,
  IViemClientManager,
  NetworkUpdateListener,
} from '@concero/operator-utils/src/types/managers';
import type { Address, PublicClient } from 'viem';
import { formatUnits } from 'viem';
import { abi as ERC20_ABI } from '../constants/erc20Abi.json';
import type { DeploymentManager } from './DeploymentManager';

export interface TokenBalance {
  native: bigint;
  usdc: bigint;
  iou: bigint;
}

export interface BalanceManagerConfig {
  updateIntervalMs: number;
}

export class BalanceManager
  extends ManagerBase
  implements NetworkUpdateListener
{
  private static instance: BalanceManager;
  private balances: Map<string, TokenBalance> = new Map();
  private viemClientManager: IViemClientManager;
  private deploymentManager: DeploymentManager;
  private txReader: ITxReader;
  private logger: LoggerInterface;
  private config: BalanceManagerConfig;
  private updateIntervalId: NodeJS.Timeout | null = null;
  private activeNetworks: ConceroNetwork[] = [];
  private watcherIds: string[] = [];

  private constructor(
    logger: LoggerInterface,
    viemClientManager: IViemClientManager,
    deploymentManager: DeploymentManager,
    txReader: ITxReader,
    config: BalanceManagerConfig
  ) {
    super();
    this.logger = logger;
    this.viemClientManager = viemClientManager;
    this.deploymentManager = deploymentManager;
    this.txReader = txReader;
    this.config = config;
  }

  public static createInstance(
    logger: LoggerInterface,
    viemClientManager: IViemClientManager,
    deploymentManager: DeploymentManager,
    txReader: ITxReader,
    config: BalanceManagerConfig
  ): BalanceManager {
    BalanceManager.instance = new BalanceManager(
      logger,
      viemClientManager,
      deploymentManager,
      txReader,
      config
    );
    return BalanceManager.instance;
  }

  public static getInstance(): BalanceManager {
    if (!BalanceManager.instance) {
      throw new Error(
        'BalanceManager is not initialized. Call createInstance() first.'
      );
    }
    return BalanceManager.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Start balance watchers using TxReader
      this.startBalanceWatchers();
      this.logger.debug('Initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize BalanceManager: ${error}`);
      throw error;
    }
  }

  private startBalanceWatchers(): void {
    this.clearBalanceWatchers();

    const deployments = this.deploymentManager.getDeployments();

    // Create watchers for each active network
    for (const network of this.activeNetworks) {
      const usdcAddress = deployments.usdcTokens[network.name];
      const iouAddress = deployments.iouTokens[network.name];

      if (!usdcAddress || !iouAddress) {
        this.logger.warn(
          `Missing token addresses for network ${network.name}, skipping balance watcher`
        );
        continue;
      }

      // Create watcher for USDC balance
      const usdcWatcherId = this.txReader.readContractWatcher.create(
        usdcAddress,
        network,
        'balanceOf',
        ERC20_ABI,
        async (result: bigint) => {
          this.onTokenBalanceUpdate(network.name, 'usdc', result);
        },
        this.config.updateIntervalMs,
        [this.getAccountAddress(network)]
      );
      this.watcherIds.push(usdcWatcherId);

      // Create watcher for IOU balance
      const iouWatcherId = this.txReader.readContractWatcher.create(
        iouAddress,
        network,
        'balanceOf',
        ERC20_ABI,
        async (result: bigint) => {
          this.onTokenBalanceUpdate(network.name, 'iou', result);
        },
        this.config.updateIntervalMs,
        [this.getAccountAddress(network)]
      );
      this.watcherIds.push(iouWatcherId);

      // Create watcher for native balance (handled differently as it's not a contract call)
      // For native balance, we'll use the existing update cycle for now
      // or we could create a custom watcher that uses getBalance
    }

    this.logger.debug(
      `Started ${this.watcherIds.length} balance watchers for ${this.activeNetworks.length} networks`
    );
  }

  private getAccountAddress(network: ConceroNetwork): Address {
    const { account } = this.viemClientManager.getClients(network);
    return account.address;
  }

  private onTokenBalanceUpdate(
    networkName: string,
    tokenType: 'usdc' | 'iou',
    newBalance: bigint
  ): void {
    const currentBalance = this.balances.get(networkName);
    if (!currentBalance) {
      // Initialize balance if not exists
      this.balances.set(networkName, {
        native: 0n,
        usdc: tokenType === 'usdc' ? newBalance : 0n,
        iou: tokenType === 'iou' ? newBalance : 0n,
      });
    } else {
      // Update specific token balance
      const updatedBalance = { ...currentBalance };
      updatedBalance[tokenType] = newBalance;
      this.balances.set(networkName, updatedBalance);
    }
  }

  public async updateBalances(networks: ConceroNetwork[]): Promise<void> {
    // This method is now primarily for initial setup and native balance updates
    // Token balances are handled by TxReader watchers
    await this.updateNativeBalances(networks);

    // Initial token balance fetch if not already set
    const deployments = this.deploymentManager.getDeployments();

    for (const network of networks) {
      const { publicClient, account } =
        this.viemClientManager.getClients(network);
      const usdcAddress = deployments.usdcTokens[network.name];
      const iouAddress = deployments.iouTokens[network.name];

      const currentBalance = this.balances.get(network.name);
      if (
        !currentBalance ||
        (currentBalance.usdc === 0n && currentBalance.iou === 0n)
      ) {
        // Initial fetch if balance doesn't exist or is zero
        const [usdcBalance, iouBalance] = await Promise.all([
          usdcAddress
            ? this.getTokenBalance(publicClient, usdcAddress, account.address)
            : 0n,
          iouAddress
            ? this.getTokenBalance(publicClient, iouAddress, account.address)
            : 0n,
        ]);

        const nativeBalance = await publicClient.getBalance({
          address: account.address,
        });

        this.balances.set(network.name, {
          native: nativeBalance,
          usdc: usdcBalance,
          iou: iouBalance,
        });
      }
    }
  }

  private async getTokenBalance(
    publicClient: PublicClient,
    tokenAddress: Address | undefined,
    accountAddress: Address
  ): Promise<bigint> {
    if (!tokenAddress) {
      return 0n;
    }

    try {
      const balance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [accountAddress],
      });

      return balance as bigint;
    } catch (error) {
      this.logger.error(
        `Failed to get token balance for ${tokenAddress}:`,
        error
      );
      return 0n;
    }
  }

  public getBalance(networkName: string): TokenBalance | undefined {
    return this.balances.get(networkName);
  }

  public getAllBalances(): Map<string, TokenBalance> {
    return new Map(this.balances);
  }

  public getTotalUsdcBalance(): bigint {
    let total = 0n;
    for (const balance of this.balances.values()) {
      total += balance.usdc;
    }
    return total;
  }

  public getTotalIouBalance(): bigint {
    let total = 0n;
    for (const balance of this.balances.values()) {
      total += balance.iou;
    }
    return total;
  }

  public hasNativeBalance(
    networkName: string,
    minimumBalance: bigint = 0n
  ): boolean {
    const balance = this.balances.get(networkName);
    return balance ? balance.native > minimumBalance : false;
  }

  public hasUsdcBalance(
    networkName: string,
    minimumBalance: bigint = 0n
  ): boolean {
    const balance = this.balances.get(networkName);
    return balance ? balance.usdc > minimumBalance : false;
  }

  public hasIouBalance(
    networkName: string,
    minimumBalance: bigint = 0n
  ): boolean {
    const balance = this.balances.get(networkName);
    return balance ? balance.iou > minimumBalance : false;
  }

  // NetworkUpdateListener implementation
  public async onNetworksUpdated(networks: ConceroNetwork[]): Promise<void> {
    this.activeNetworks = networks;

    // Clear balances for networks that are no longer active
    const activeNetworkNames = new Set(networks.map((n) => n.name));
    for (const networkName of this.balances.keys()) {
      if (!activeNetworkNames.has(networkName)) {
        this.balances.delete(networkName);
        this.logger.debug(
          `Removed balance tracking for inactive network: ${networkName}`
        );
      }
    }

    // Recreate watchers for new active networks
    this.startBalanceWatchers();

    // Also update native balances since they can't be watched via contract
    await this.updateNativeBalances(networks);
  }

  public async forceUpdate(): Promise<void> {
    await this.updateNativeBalances(this.activeNetworks);
    this.logger.debug('Force updated balances');
  }

  private async updateNativeBalances(
    networks: ConceroNetwork[]
  ): Promise<void> {
    const balancePromises = networks.map(async (network) => {
      try {
        const { publicClient, account } =
          this.viemClientManager.getClients(network);

        const nativeBalance = await publicClient.getBalance({
          address: account.address,
        });

        const currentBalance = this.balances.get(network.name);
        const updatedBalance: TokenBalance = {
          native: nativeBalance,
          usdc: currentBalance?.usdc || 0n,
          iou: currentBalance?.iou || 0n,
        };

        this.balances.set(network.name, updatedBalance);

        return { network: network.name, success: true };
      } catch (error) {
        this.logger.error(
          `Failed to update native balance for ${network.name}:`,
          error
        );
        return { network: network.name, success: false, error };
      }
    });

    const results = await Promise.all(balancePromises);
    const failedNetworks = results.filter((r) => !r.success);

    if (failedNetworks.length > 0) {
      this.logger.warn(
        `Failed to update native balances for ${failedNetworks.length} networks: ${failedNetworks.map((f) => f.network).join(', ')}`
      );
    }
  }

  public async ensureAllowance(
    networkName: string,
    tokenAddress: string,
    spenderAddress: string,
    requiredAmount: bigint,
    minAllowance: bigint,
    tokenDecimals: number
  ): Promise<void> {
    const network = this.activeNetworks.find((n) => n.name === networkName);
    if (!network)
      throw new Error(`Network ${networkName} not found or not active`);

    const { publicClient, walletClient } =
      this.viemClientManager.getClients(network);
    if (!walletClient)
      throw new Error(`No wallet client found for ${networkName}`);

    const currentAllowance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [walletClient.account.address, spenderAddress as `0x${string}`],
    });

    if (currentAllowance >= requiredAmount) {
      this.logger.debug(
        `Allowance sufficient: ${formatUnits(currentAllowance, tokenDecimals)} >= ${formatUnits(requiredAmount, tokenDecimals)}`
      );
      return;
    }

    const newAllowance =
      requiredAmount > minAllowance ? requiredAmount : minAllowance;
    this.logger.info(
      `Setting allowance: ${formatUnits(currentAllowance, tokenDecimals)} -> ${formatUnits(newAllowance, tokenDecimals)}`
    );

    const txHash = await walletClient.writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spenderAddress as `0x${string}`, newAllowance],
    });

    this.logger.info(`Approve tx submitted: ${txHash} on ${networkName}`);
  }

  public async getAllowance(
    networkName: string,
    tokenAddress: string,
    spenderAddress: string
  ): Promise<bigint> {
    const network = this.activeNetworks.find((n) => n.name === networkName);
    if (!network)
      throw new Error(`Network ${networkName} not found or not active`);

    const { publicClient, walletClient } =
      this.viemClientManager.getClients(network);
    if (!walletClient)
      throw new Error(`No wallet client found for ${networkName}`);

    const allowance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [walletClient.account.address, spenderAddress as `0x${string}`],
    });

    return allowance as bigint;
  }

  private clearBalanceWatchers(): void {
    for (const watcherId of this.watcherIds) {
      this.txReader.readContractWatcher.remove(watcherId);
    }
    this.watcherIds = [];
  }

  public dispose(): void {
    this.clearBalanceWatchers();

    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
    this.balances.clear();
    super.dispose();
    this.logger.debug('Disposed');
  }
}
