import { ManagerBase } from '@concero/operator-utils';
import type { ConceroNetwork } from '@concero/operator-utils/src/types/ConceroNetwork';
import type { LoggerInterface } from '@concero/operator-utils/src/types/LoggerInterface';
import type {
  IViemClientManager,
  NetworkUpdateListener,
} from '@concero/operator-utils/src/types/managers';
import type { Address, PublicClient } from 'viem';
import { formatUnits } from 'viem';
import {
  IOU_TOKEN_DECIMALS,
  NATIVE_DECIMALS,
  USDC_DECIMALS,
} from '../constants';
import type { DeploymentManager } from './DeploymentManager';

export interface TokenBalance {
  native: bigint;
  usdc: bigint;
  iou: bigint;
}

export interface BalanceManagerConfig {
  updateIntervalMs: number;
}

// ERC20 ABI for balanceOf function
const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export class BalanceManager
  extends ManagerBase
  implements NetworkUpdateListener
{
  private static instance: BalanceManager;
  private balances: Map<string, TokenBalance> = new Map();
  private viemClientManager: IViemClientManager;
  private deploymentManager: DeploymentManager;
  private logger: LoggerInterface;
  private config: BalanceManagerConfig;
  private updateIntervalId: NodeJS.Timeout | null = null;
  private activeNetworks: ConceroNetwork[] = [];

  private constructor(
    logger: LoggerInterface,
    viemClientManager: IViemClientManager,
    deploymentManager: DeploymentManager,
    config: BalanceManagerConfig
  ) {
    super();
    this.logger = logger;
    this.viemClientManager = viemClientManager;
    this.deploymentManager = deploymentManager;
    this.config = config;
  }

  public static createInstance(
    logger: LoggerInterface,
    viemClientManager: IViemClientManager,
    deploymentManager: DeploymentManager,
    config: BalanceManagerConfig
  ): BalanceManager {
    BalanceManager.instance = new BalanceManager(
      logger,
      viemClientManager,
      deploymentManager,
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
      // Start update cycle
      this.startUpdateCycle();

      this.initialized = true;
      this.logger.debug('Initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize BalanceManager: ${error}`);
      throw error;
    }
  }

  private startUpdateCycle(): void {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
    }

    // Initial update
    this.updateBalances(this.activeNetworks).catch((err) =>
      this.logger.error(`Initial balance update failed: ${err}`)
    );

    // Set up periodic updates
    this.updateIntervalId = setInterval(
      () =>
        this.updateBalances(this.activeNetworks).catch((err) =>
          this.logger.error(`Balance update failed: ${err}`)
        ),
      this.config.updateIntervalMs
    );

    this.logger.debug(
      `Started balance update cycle with interval: ${this.config.updateIntervalMs}ms`
    );
  }

  public async updateBalances(networks: ConceroNetwork[]): Promise<void> {
    const deployments = this.deploymentManager.getDeployments();

    // Update balances in parallel for all networks
    const balancePromises = networks.map(async (network) => {
      try {
        const { publicClient, account } =
          this.viemClientManager.getClients(network);
        const usdcAddress = deployments.usdcTokens[network.name];
        const iouAddress = deployments.iouTokens[network.name];

        // Fetch all balances in parallel
        const [nativeBalance, usdcBalance, iouBalance] = await Promise.all([
          publicClient.getBalance({ address: account.address }),
          usdcAddress
            ? this.getTokenBalance(publicClient, usdcAddress, account.address)
            : Promise.resolve(0n),
          iouAddress
            ? this.getTokenBalance(publicClient, iouAddress, account.address)
            : Promise.resolve(0n),
        ]);

        const balance: TokenBalance = {
          native: nativeBalance,
          usdc: usdcBalance,
          iou: iouBalance,
        };

        this.balances.set(network.name, balance);

        return { network: network.name, success: true };
      } catch (error) {
        this.logger.error(
          `Failed to update balances for ${network.name}:`,
          error
        );
        return { network: network.name, success: false, error };
      }
    });

    const results = await Promise.all(balancePromises);
    const failedNetworks = results.filter((r) => !r.success);

    if (failedNetworks.length > 0) {
      this.logger.warn(
        `Failed to update balances for ${failedNetworks.length} networks: ${failedNetworks.map((f) => f.network).join(', ')}`
      );
    }
    //console.table this.balances by network, but make it human readable
    console.table(
      Array.from(this.balances.entries()).map(([network, balance]) => ({
        network,
        usdc: formatUnits(balance.usdc.toString(), USDC_DECIMALS),
        iou: formatUnits(balance.iou.toString(), IOU_TOKEN_DECIMALS),
        native: formatUnits(balance.native.toString(), NATIVE_DECIMALS),
      })),
      ['network', 'usdc', 'iou', 'native']
    );
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

    // Update balances for active networks
    await this.updateBalances(networks);
  }

  public async forceUpdate(): Promise<void> {
    await this.updateBalances(this.activeNetworks);
    this.logger.debug('Force updated balances');
  }

  public dispose(): void {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
    this.balances.clear();
    super.dispose();
    this.logger.debug('Disposed');
  }
}
