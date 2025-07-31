import { ManagerBase } from '@concero/operator-utils';
import type { ConceroNetwork } from '@concero/operator-utils/src/types/ConceroNetwork';
import type { LoggerInterface } from '@concero/operator-utils/src/types/LoggerInterface';
import type {
  ITxMonitor,
  ITxReader,
  ITxWriter,
  IViemClientManager,
} from '@concero/operator-utils/src/types/managers';
import { formatUnits } from 'viem';
import { IOU_TOKEN_DECIMALS, USDC_DECIMALS } from '../constants';
import { abi as LBF_PARENT_POOL_ABI } from '../constants/lbfAbi.json';
import { abi as ERC20_ABI } from '../constants/erc20Abi.json';
import type { BalanceManager } from './BalanceManager';
import type { DeploymentManager } from './DeploymentManager';
import type { LancaNetworkManager } from './LancaNetworkManager';
export interface RebalancerConfig {
  deficitThreshold: bigint;
  surplusThreshold: bigint;
  checkIntervalMs: number;
  netTotalAllowance: bigint;
  minAllowance: {
    USDC: bigint;
    IOU: bigint;
  };
}

export interface PoolData {
  deficit: bigint;
  surplus: bigint;
  lastUpdated: Date;
}

export interface RebalanceOpportunity {
  type: 'fillDeficit' | 'bridgeIOU' | 'redeemSurplus';
  fromNetwork?: string;
  toNetwork: string;
  amount: bigint;
  reason: string;
}

export class Rebalancer extends ManagerBase {
  private static instance: Rebalancer;
  private poolData: Map<string, PoolData> = new Map();
  private watcherIds: string[] = [];
  private totalRedeemedUsdc: bigint = 0n; // Track total USDC redeemed

  private txReader: ITxReader;
  private txWriter: ITxWriter;
  private txMonitor: ITxMonitor;
  private viemClientManager: IViemClientManager;
  private balanceManager: BalanceManager;
  private deploymentManager: DeploymentManager;
  private networkManager: LancaNetworkManager;
  private logger: LoggerInterface;
  private config: RebalancerConfig;
  private allowanceCache: Map<string, Map<string, bigint>> = new Map();

  private constructor(
    logger: LoggerInterface,
    txReader: ITxReader,
    txWriter: ITxWriter,
    txMonitor: ITxMonitor,
    viemClientManager: IViemClientManager,
    balanceManager: BalanceManager,
    deploymentManager: DeploymentManager,
    networkManager: LancaNetworkManager,
    config: RebalancerConfig
  ) {
    super();
    this.logger = logger;
    this.txReader = txReader;
    this.txWriter = txWriter;
    this.txMonitor = txMonitor;
    this.viemClientManager = viemClientManager;
    this.balanceManager = balanceManager;
    this.deploymentManager = deploymentManager;
    this.networkManager = networkManager;
    this.config = config;
  }

  public static createInstance(
    logger: LoggerInterface,
    txReader: ITxReader,
    txWriter: ITxWriter,
    txMonitor: ITxMonitor,
    viemClientManager: IViemClientManager,
    balanceManager: BalanceManager,
    deploymentManager: DeploymentManager,
    networkManager: LancaNetworkManager,
    config: RebalancerConfig
  ): Rebalancer {
    Rebalancer.instance = new Rebalancer(
      logger,
      txReader,
      txWriter,
      txMonitor,
      viemClientManager,
      balanceManager,
      deploymentManager,
      networkManager,
      config
    );
    return Rebalancer.instance;
  }

  public static getInstance(): Rebalancer {
    if (!Rebalancer.instance) {
      throw new Error(
        'Rebalancer is not initialized. Call createInstance() first.'
      );
    }
    return Rebalancer.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.initialized = true;
      this.logger.debug('Initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize Rebalancer: ${error}`);
      throw error;
    }
  }

  public async setupPoolListeners(): Promise<void> {
    const networks = this.networkManager.getActiveNetworks();
    const deployments = this.deploymentManager.getDeployments();

    // First, set up parent pool listener
    const parentPoolNetwork = deployments.parentPool.network;
    const parentNetwork = networks.find((n) => n.name === parentPoolNetwork);
    if (!parentNetwork) {
      throw new Error(
        `Parent pool network ${parentPoolNetwork} not found in active networks`
      );
    }

    const parentWatcherId = this.txReader.readContractWatcher.create(
      deployments.parentPool.address,
      parentNetwork,
      'getPoolData',
      LBF_PARENT_POOL_ABI,
      async (result: [bigint, bigint], network: ConceroNetwork) => {
        await this.onPoolDataUpdate(network.name, result[0], result[1]);
      },
      this.config.checkIntervalMs
    );
    this.watcherIds.push(parentWatcherId);
    this.logger.info(
      `Set up parent pool listener for ${parentPoolNetwork} at ${deployments.parentPool.address} (interval: ${this.config.checkIntervalMs}ms)`
    );

    // Then set up child pool listeners, excluding the parent pool network
    for (const network of networks) {
      if (network.name === parentPoolNetwork) {
        continue;
      }

      const poolAddress = deployments.pools[network.name];
      if (!poolAddress) {
        this.logger.warn(`No pool address found for network ${network.name}`);
        continue;
      }

      // Create read contract watcher for getPoolData
      const watcherId = this.txReader.readContractWatcher.create(
        poolAddress,
        network,
        'getPoolData',
        LBF_PARENT_POOL_ABI,
        async (result: [bigint, bigint], network: ConceroNetwork) => {
          await this.onPoolDataUpdate(network.name, result[0], result[1]);
        },
        this.config.checkIntervalMs
      );

      this.watcherIds.push(watcherId);
      this.logger.info(
        `Set up child pool listener for ${network.name} at ${poolAddress} (interval: ${this.config.checkIntervalMs}ms)`
      );
    }
  }

  private async onPoolDataUpdate(
    networkName: string,
    deficit: bigint,
    surplus: bigint
  ): Promise<void> {
    const previousData = this.poolData.get(networkName);

    this.poolData.set(networkName, {
      deficit,
      surplus,
      lastUpdated: new Date(),
    });

    // Log significant changes
    if (
      !previousData ||
      previousData.deficit !== deficit ||
      previousData.surplus !== surplus
    ) {
      this.logger.info(
        `Pool data updated for ${networkName}: Deficit: ${formatUnits(deficit, USDC_DECIMALS)} USDC, Surplus: ${formatUnits(surplus, USDC_DECIMALS)} USDC`
      );
    }

    // Run rebalancing logic
    await this.checkRebalancingOpportunities();
  }

  private async checkRebalancingOpportunities(): Promise<void> {
    const opportunities: RebalanceOpportunity[] = [];

    // 1. Check deficit filling opportunities
    for (const [networkName, data] of this.poolData) {
      if (await this.shouldFillDeficit(networkName, data)) {
        const balance = this.balanceManager.getBalance(networkName);
        if (balance) {
          const fillAmount =
            balance.usdc < data.deficit ? balance.usdc : data.deficit;
          opportunities.push({
            type: 'fillDeficit',
            toNetwork: networkName,
            amount: fillAmount,
            reason: `Fill deficit of ${formatUnits(data.deficit, USDC_DECIMALS)} USDC`,
          });
        }
      }
    }

    // 2. Check IOU bridging opportunities
    const bridgeOps = await this.checkIOUBridgingOpportunities();
    opportunities.push(...bridgeOps);

    // 3. Check surplus redemption opportunities
    for (const [networkName, data] of this.poolData) {
      if (await this.shouldRedeemSurplus(networkName, data)) {
        const balance = this.balanceManager.getBalance(networkName);
        if (balance && balance.iou > 0n) {
          const redeemAmount =
            balance.iou < data.surplus ? balance.iou : data.surplus;
          opportunities.push({
            type: 'redeemSurplus',
            toNetwork: networkName,
            amount: redeemAmount,
            reason: `Redeem ${formatUnits(redeemAmount, USDC_DECIMALS)} USDC from surplus`,
          });
        }
      }
    }

    // Execute opportunities
    if (opportunities.length > 0) {
      this.logger.info(
        `Found ${opportunities.length} rebalancing opportunities`
      );
      for (const opportunity of opportunities) {
        await this.executeOpportunity(opportunity);
      }
    }
  }

  private async shouldFillDeficit(
    networkName: string,
    data: PoolData
  ): boolean {
    if (data.deficit < this.config.deficitThreshold) {
      return false;
    }

    const balance = this.balanceManager.getBalance(networkName);
    if (!balance || balance.usdc === 0n) {
      return false;
    }

    // Check NET_TOTAL_ALLOWANCE logic
    const totalIOUAcrossChains = this.balanceManager.getTotalIouBalance();
    const netAllowance =
      this.config.netTotalAllowance -
      (totalIOUAcrossChains - this.totalRedeemedUsdc);

    if (netAllowance <= 0n) {
      this.logger.debug(
        `Cannot fill deficit on ${networkName}: NET_TOTAL_ALLOWANCE exceeded (IOU: ${formatUnits(totalIOUAcrossChains, IOU_TOKEN_DECIMALS)}, Redeemed: ${formatUnits(this.totalRedeemedUsdc, USDC_DECIMALS)})`
      );
      return false;
    }

    // Check native gas balance
    if (!this.balanceManager.hasNativeBalance(networkName, 0n)) {
      this.logger.debug(
        `Cannot fill deficit on ${networkName}: Insufficient native gas`
      );
      return false;
    }

    return true;
  }

  private async checkIOUBridgingOpportunities(): Promise<
    RebalanceOpportunity[]
  > {
    const opportunities: RebalanceOpportunity[] = [];
    const allBalances = this.balanceManager.getAllBalances();

    // Find networks with IOU balance
    const networksWithIOU = Array.from(allBalances.entries())
      .filter(([, balance]) => balance.iou > 0n)
      .map(([network, balance]) => ({ network, iouBalance: balance.iou }));

    if (networksWithIOU.length === 0) return opportunities;

    // Find network with highest surplus
    let bestSurplusNetwork: string | null = null;
    let highestSurplus = 0n;

    for (const [networkName, data] of this.poolData) {
      if (
        data.surplus > highestSurplus &&
        data.surplus >= this.config.surplusThreshold
      ) {
        highestSurplus = data.surplus;
        bestSurplusNetwork = networkName;
      }
    }

    if (!bestSurplusNetwork || highestSurplus === 0n) {
      return opportunities;
    }

    // Create bridge opportunities to the best surplus network
    for (const { network: fromNetwork, iouBalance } of networksWithIOU) {
      if (fromNetwork === bestSurplusNetwork) continue;

      // Check native gas on source network
      if (!this.balanceManager.hasNativeBalance(fromNetwork, 0n)) {
        this.logger.debug(
          `Cannot bridge IOU from ${fromNetwork}: Insufficient native gas`
        );
        continue;
      }

      opportunities.push({
        type: 'bridgeIOU',
        fromNetwork,
        toNetwork: bestSurplusNetwork,
        amount: iouBalance,
        reason: `Bridge ${formatUnits(iouBalance, IOU_TOKEN_DECIMALS)} IOU to ${bestSurplusNetwork} (surplus: ${formatUnits(highestSurplus, USDC_DECIMALS)})`,
      });
    }

    return opportunities;
  }

  private async shouldRedeemSurplus(
    networkName: string,
    data: PoolData
  ): boolean {
    if (data.surplus < this.config.surplusThreshold) {
      return false;
    }

    const balance = this.balanceManager.getBalance(networkName);
    if (!balance || balance.iou === 0n) {
      return false;
    }

    // Check native gas balance
    if (!this.balanceManager.hasNativeBalance(networkName, 0n)) {
      this.logger.debug(
        `Cannot redeem surplus on ${networkName}: Insufficient native gas`
      );
      return false;
    }

    return true;
  }

  private async executeOpportunity(
    opportunity: RebalanceOpportunity
  ): Promise<void> {
    try {
      this.logger.info(`Executing ${opportunity.type}: ${opportunity.reason}`);

      switch (opportunity.type) {
        case 'fillDeficit':
          await this.fillDeficit(opportunity.toNetwork, opportunity.amount);
          break;
        case 'bridgeIOU':
          await this.bridgeIOU(
            opportunity.fromNetwork!,
            opportunity.toNetwork,
            opportunity.amount
          );
          break;
        case 'redeemSurplus':
          await this.redeemSurplus(opportunity.toNetwork, opportunity.amount);
          break;
      }
    } catch (error) {
      this.logger.error(
        `Failed to execute ${opportunity.type} opportunity: ${error}`
      );
    }
  }

  private async fillDeficit(
    networkName: string,
    amount: bigint
  ): Promise<void> {
    const network = this.networkManager.getNetworkByName(networkName);
    if (!network) throw new Error(`Network ${networkName} not found`);

    const poolAddress = this.deploymentManager.getPoolAddress(networkName);
    if (!poolAddress)
      throw new Error(`Pool address not found for ${networkName}`);

    const usdcAddress = this.deploymentManager.getUsdcAddress(networkName);
    if (!usdcAddress)
      throw new Error(`USDC address not found for ${networkName}`);

    // Ensure USDC allowance before proceeding
    const allowanceSet = await this.ensureAllowance(
      networkName,
      usdcAddress,
      poolAddress,
      amount,
      this.config.minAllowance.USDC
    );

    if (!allowanceSet) {
      this.logger.error(`Failed to set USDC allowance for ${poolAddress} on ${networkName}`);
      return;
    }

    this.logger.info(
      `Filling deficit on ${networkName} with ${formatUnits(amount, USDC_DECIMALS)} USDC`
    );

    // Execute transaction
    const txId = await this.txWriter.callContract(network, {
      address: poolAddress,
      abi: LBF_PARENT_POOL_ABI,
      functionName: 'fillDeficit',
      args: [amount],
    });

    this.logger.info(`Fill deficit tx submitted: ${txId} on ${networkName}`);
  }

  private async bridgeIOU(
    fromNetwork: string,
    toNetwork: string,
    amount: bigint
  ): Promise<void> {
    const sourceNetwork = this.networkManager.getNetworkByName(fromNetwork);
    const destNetwork = this.networkManager.getNetworkByName(toNetwork);
    if (!sourceNetwork || !destNetwork) {
      throw new Error(
        `Network not found: ${!sourceNetwork ? fromNetwork : toNetwork}`
      );
    }

    const poolAddress = this.deploymentManager.getPoolAddress(fromNetwork);
    if (!poolAddress)
      throw new Error(`Pool address not found for ${fromNetwork}`);

    const iouAddress = this.deploymentManager.getIouAddress(fromNetwork);
    if (!iouAddress)
      throw new Error(`IOU address not found for ${fromNetwork}`);

    // Ensure IOU allowance before proceeding
    const allowanceSet = await this.ensureAllowance(
      fromNetwork,
      iouAddress,
      poolAddress,
      amount,
      this.config.minAllowance.IOU
    );

    if (!allowanceSet) {
      this.logger.error(`Failed to set IOU allowance for ${poolAddress} on ${fromNetwork}`);
      return;
    }

    this.logger.info(
      `Bridging ${formatUnits(amount, IOU_TOKEN_DECIMALS)} IOU from ${fromNetwork} to ${toNetwork}`
    );

    // Execute transaction
    const txId = await this.txWriter.callContract(sourceNetwork, {
      address: poolAddress,
      abi: LBF_PARENT_POOL_ABI,
      functionName: 'bridgeIOU',
      args: [amount, BigInt(destNetwork.id)],
    });

    this.logger.info(
      `Bridge IOU tx submitted: ${txId} from ${fromNetwork} to ${toNetwork}`
    );
  }

  private async redeemSurplus(
    networkName: string,
    amount: bigint
  ): Promise<void> {
    const network = this.networkManager.getNetworkByName(networkName);
    if (!network) throw new Error(`Network ${networkName} not found`);

    const poolAddress = this.deploymentManager.getPoolAddress(networkName);
    if (!poolAddress)
      throw new Error(`Pool address not found for ${networkName}`);

    const iouAddress = this.deploymentManager.getIouAddress(networkName);
    if (!iouAddress)
      throw new Error(`IOU address not found for ${networkName}`);

    // Ensure IOU allowance before proceeding
    const allowanceSet = await this.ensureAllowance(
      networkName,
      iouAddress,
      poolAddress,
      amount,
      this.config.minAllowance.IOU
    );

    if (!allowanceSet) {
      this.logger.error(`Failed to set IOU allowance for ${poolAddress} on ${networkName}`);
      return;
    }

    this.logger.info(
      `Redeeming ${formatUnits(amount, USDC_DECIMALS)} USDC from surplus on ${networkName}`
    );

    // Execute transaction
    const txId = await this.txWriter.callContract(network, {
      address: poolAddress,
      abi: LBF_PARENT_POOL_ABI,
      functionName: 'redeemSurplus',
      args: [amount],
    });

    // Track redeemed amount
    this.totalRedeemedUsdc += amount;

    this.logger.info(`Redeem surplus tx submitted: ${txId} on ${networkName}`);
  }

  public getPoolData(networkName: string): PoolData | undefined {
    return this.poolData.get(networkName);
  }

  public getAllPoolData(): Map<string, PoolData> {
    return new Map(this.poolData);
  }

  private async ensureAllowance(
    networkName: string,
    tokenAddress: string,
    spenderAddress: string,
    requiredAmount: bigint,
    minAllowance: bigint
  ): Promise<boolean> {
    const network = this.networkManager.getNetworkByName(networkName);
    if (!network) {
      this.logger.error(`Network ${networkName} not found for allowance check`);
      return false;
    }

    try {
      const clients = this.viemClientManager.getClients(network);
      const { walletClient } = clients;
      if (!walletClient) {
        this.logger.error(`No wallet client found for ${networkName}`);
        return false;
      }

      const operatorAddress = walletClient.account?.address;
      if (!operatorAddress) {
        this.logger.error(`No operator address found for ${networkName}`);
        return false;
      }

      // Check current allowance
      const currentAllowance = await walletClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [operatorAddress, spenderAddress as `0x${string}`],
      });

      // If allowance is sufficient, return early
      if (currentAllowance >= requiredAmount) {
        this.logger.debug(
          `Allowance sufficient: ${currentAllowance} >= ${requiredAmount} for ${spenderAddress}`
        );
        return true;
      }

      // Calculate new allowance (max of requiredAmount and minAllowance)
      const newAllowance = requiredAmount > minAllowance ? requiredAmount : minAllowance;

      this.logger.info(
        `Setting allowance for ${spenderAddress}: ${currentAllowance} -> ${newAllowance}`
      );

      // Set new allowance
      const txHash = await walletClient.writeContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spenderAddress as `0x${string}`, newAllowance],
      });

      this.logger.info(`Approve tx submitted: ${txHash} on ${networkName}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to ensure allowance on ${networkName}: ${error}`);
      return false;
    }
  }

  public dispose(): void {
    // Clean up watchers
    for (const watcherId of this.watcherIds) {
      this.txReader.readContractWatcher.remove(watcherId);
    }
    this.watcherIds = [];
    this.poolData.clear();
    this.allowanceCache.clear();
    super.dispose();
    this.logger.debug('Disposed');
  }
}
