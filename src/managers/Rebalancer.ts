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
import { abi as ERC20_ABI } from '../constants/erc20Abi.json';
import { abi as LBF_PARENT_POOL_ABI } from '../constants/lbfAbi.json';
import type { BalanceManager } from './BalanceManager';
import type { DeploymentManager } from './DeploymentManager';
import type { LancaNetworkManager } from './LancaNetworkManager';
import {
  OpportunityScorer,
  PoolData,
  ScoredOpportunity,
} from './OpportunityScroer';

export interface RebalancerConfig {
  deficitThreshold: bigint;
  surplusThreshold: bigint;
  checkIntervalMs: number;
  netTotalAllowance: bigint;
  minAllowance: {
    USDC: bigint;
    IOU: bigint;
  };
  opportunityScorer: {
    minScore: number;
  };
}

export interface RebalanceOpportunity {
  type: 'fillDeficit' | 'bridgeIOU' | 'takeSurplus';
  fromNetwork?: string;
  toNetwork: string;
  amount: bigint;
  reason: string;
}

export class Rebalancer extends ManagerBase {
  private static instance: Rebalancer;
  private poolData: Map<string, PoolData> = new Map();
  private watcherIds: string[] = [];
  private totalRedeemedUsdc: bigint = 0n;
  private opportunityScorer: OpportunityScorer;

  private txReader: ITxReader;
  private txWriter: ITxWriter;
  private txMonitor: ITxMonitor;
  private viemClientManager: IViemClientManager;
  private balanceManager: BalanceManager;
  private deploymentManager: DeploymentManager;
  private networkManager: LancaNetworkManager;
  private logger: LoggerInterface;
  private config: RebalancerConfig;

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

    this.opportunityScorer = new OpportunityScorer(
      logger,
      balanceManager,
      networkManager,
      config
    );
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
      this.logger.debug('Rebalancer initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize Rebalancer: ${error}`);
      throw error;
    }
  }

  public async setupPoolListeners(): Promise<void> {
    const networks = this.networkManager.getActiveNetworks();
    const deployments = this.deploymentManager.getDeployments();

    const parentPoolNetwork = deployments.parentPool.network;
    const parentNetwork = networks.find((n) => n.name === parentPoolNetwork);
    if (!parentNetwork) {
      throw new Error(
        `Parent pool network ${parentPoolNetwork} not found in active networks`
      );
    }

    // Setup parent pool listener
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

    // Setup child pool listeners
    for (const network of networks) {
      if (network.name === parentPoolNetwork) continue;

      const poolAddress = deployments.pools[network.name];
      if (!poolAddress) {
        this.logger.warn(`No pool address found for network ${network.name}`);
        continue;
      }

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
    }

    this.logger.info(`Setup ${this.watcherIds.length} pool listeners`);
  }

  private async onPoolDataUpdate(
    networkName: string,
    deficit: bigint,
    surplus: bigint
  ): Promise<void> {
    this.poolData.set(networkName, {
      deficit,
      surplus,
      lastUpdated: new Date(),
    });

    this.logger.debug(
      `Pool data updated for ${networkName}: ` +
        `Deficit: ${formatUnits(deficit, USDC_DECIMALS)} USDC, ` +
        `Surplus: ${formatUnits(surplus, USDC_DECIMALS)} USDC`
    );

    await this.checkRebalancingOpportunities();
  }

  private async checkRebalancingOpportunities(): Promise<void> {
    const allOpportunities = this.discoverOpportunities();

    if (allOpportunities.length === 0) return;

    this.logger.info(
      `Discovered ${allOpportunities.length} potential opportunities`
    );

    const scoredOpportunities =
      await this.opportunityScorer.scoreAndFilterOpportunities(
        allOpportunities
      );

    if (scoredOpportunities.length === 0) {
      this.logger.info('No feasible opportunities after scoring');
      return;
    }

    this.logger.info(
      `Found ${scoredOpportunities.length} feasible opportunities:`
    );
    scoredOpportunities.forEach((scored, index) => {
      this.logger.info(
        `  ${index + 1}. ${scored.opportunity.type} (Score: ${scored.score.toFixed(2)}): ${scored.opportunity.reason}`
      );
    });

    await this.executeOpportunities(scoredOpportunities);
  }

  private discoverOpportunities(): RebalanceOpportunity[] {
    const opportunities: RebalanceOpportunity[] = [];

    // 1. Deficit filling opportunities
    for (const [networkName, data] of this.poolData) {
      if (data.deficit >= this.config.deficitThreshold) {
        const balance = this.balanceManager.getBalance(networkName);
        if (balance && balance.usdc > 0n) {
          const fillAmount =
            balance.usdc < data.deficit ? balance.usdc : data.deficit;

          // Check NET_TOTAL_ALLOWANCE
          const totalIOUAcrossChains = this.balanceManager.getTotalIouBalance();
          const netAllowance =
            this.config.netTotalAllowance -
            (totalIOUAcrossChains - this.totalRedeemedUsdc);

          if (netAllowance > 0n) {
            const actualAmount =
              fillAmount < netAllowance ? fillAmount : netAllowance;
            opportunities.push({
              type: 'fillDeficit',
              toNetwork: networkName,
              amount: actualAmount,
              reason: `Fill deficit of ${formatUnits(data.deficit, USDC_DECIMALS)} USDC`,
            });
          }
        }
      }
    }

    // 2. Surplus redemption opportunities
    for (const [networkName, data] of this.poolData) {
      if (data.surplus >= this.config.surplusThreshold) {
        const balance = this.balanceManager.getBalance(networkName);
        if (balance && balance.iou > 0n) {
          const redeemAmount =
            balance.iou < data.surplus ? balance.iou : data.surplus;
          opportunities.push({
            type: 'takeSurplus',
            toNetwork: networkName,
            amount: redeemAmount,
            reason: `Redeem ${formatUnits(redeemAmount, USDC_DECIMALS)} USDC from surplus`,
          });
        }
      }
    }

    // 3. IOU bridging opportunities (only if no local opportunities)
    const bridgeOpportunities = this.discoverIOUBridgingOpportunities();
    opportunities.push(...bridgeOpportunities);

    return opportunities;
  }

  private discoverIOUBridgingOpportunities(): RebalanceOpportunity[] {
    const opportunities: RebalanceOpportunity[] = [];
    const allBalances = this.balanceManager.getAllBalances();

    // Find networks with IOU but no local opportunities
    const candidateNetworks = Array.from(allBalances.entries())
      .filter(([network, balance]) => {
        if (balance.iou === 0n) return false;

        // Check if network has local opportunities
        const poolData = this.poolData.get(network);
        if (!poolData) return false;

        const hasLocalDeficit =
          poolData.deficit >= this.config.deficitThreshold;
        const hasLocalSurplus =
          poolData.surplus >= this.config.surplusThreshold;

        return !hasLocalDeficit && !hasLocalSurplus;
      })
      .map(([network, balance]) => ({ network, iouBalance: balance.iou }));

    if (candidateNetworks.length === 0) return opportunities;

    // Find best surplus network
    const surplusNetworks = Array.from(this.poolData.entries())
      .filter(([, data]) => data.surplus >= this.config.surplusThreshold)
      .sort(([, a], [, b]) => (a.surplus > b.surplus ? -1 : 1));

    if (surplusNetworks.length === 0) return opportunities;

    const [bestSurplusNetwork, bestSurplusData] = surplusNetworks[0];

    // Create bridge opportunities to best surplus network
    for (const { network: fromNetwork, iouBalance } of candidateNetworks) {
      if (fromNetwork === bestSurplusNetwork) continue;

      opportunities.push({
        type: 'bridgeIOU',
        fromNetwork,
        toNetwork: bestSurplusNetwork,
        amount: iouBalance,
        reason: `Bridge ${formatUnits(iouBalance, IOU_TOKEN_DECIMALS)} IOU to ${bestSurplusNetwork} (surplus: ${formatUnits(bestSurplusData.surplus, USDC_DECIMALS)} USDC)`,
      });
    }

    return opportunities;
  }

  private async executeOpportunities(
    scoredOpportunities: ScoredOpportunity[]
  ): Promise<void> {
    let executedCount = 0;

    for (const scored of scoredOpportunities) {
      try {
        await this.executeOpportunity(scored.opportunity);
        executedCount++;
      } catch (error) {
        this.logger.error(`Failed to execute opportunity: ${error}`);
      }
    }

    if (executedCount > 0) {
      this.logger.info(`Successfully executed ${executedCount} opportunities`);
    }
  }

  private async executeOpportunity(
    opportunity: RebalanceOpportunity
  ): Promise<void> {
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
      case 'takeSurplus':
        await this.takeSurplus(opportunity.toNetwork, opportunity.amount);
        break;
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

    await this.ensureAllowance(
      networkName,
      usdcAddress,
      poolAddress,
      amount,
      this.config.minAllowance.USDC,
      USDC_DECIMALS
    );

    this.logger.info(
      `Filling deficit on ${networkName} with ${formatUnits(amount, USDC_DECIMALS)} USDC`
    );

    const { walletClient, publicClient } =
      this.viemClientManager.getClients(network);
    if (!walletClient)
      throw new Error(`No wallet client found for ${networkName}`);

    const txHash = await walletClient.writeContract({
      address: poolAddress as `0x${string}`,
      abi: LBF_PARENT_POOL_ABI,
      functionName: 'fillDeficit',
      args: [amount],
      gas: 1_000_000,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    this.logger.info(`Fill deficit tx submitted: ${txHash} on ${networkName}`);
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

    await this.ensureAllowance(
      fromNetwork,
      iouAddress,
      poolAddress,
      amount,
      this.config.minAllowance.IOU,
      IOU_TOKEN_DECIMALS
    );

    this.logger.info(
      `Bridging ${formatUnits(amount, IOU_TOKEN_DECIMALS)} IOU from ${fromNetwork} to ${toNetwork}`
    );

    const { walletClient, publicClient } =
      this.viemClientManager.getClients(sourceNetwork);
    if (!walletClient)
      throw new Error(`No wallet client found for ${fromNetwork}`);

    const txHash = await walletClient.writeContract({
      address: poolAddress as `0x${string}`,
      abi: LBF_PARENT_POOL_ABI,
      functionName: 'bridgeIOU',
      args: [amount, BigInt(destNetwork.id)],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    this.logger.info(
      `Bridge IOU tx submitted: ${txHash} from ${fromNetwork} to ${toNetwork}`
    );
  }

  private async takeSurplus(
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

    await this.ensureAllowance(
      networkName,
      iouAddress,
      poolAddress,
      amount,
      this.config.minAllowance.IOU,
      IOU_TOKEN_DECIMALS
    );

    this.logger.info(
      `Redeeming ${formatUnits(amount, USDC_DECIMALS)} USDC from surplus on ${networkName}`
    );

    const { walletClient, publicClient } =
      this.viemClientManager.getClients(network);
    if (!walletClient)
      throw new Error(`No wallet client found for ${networkName}`);

    const txHash = await walletClient.writeContract({
      address: poolAddress as `0x${string}`,
      abi: LBF_PARENT_POOL_ABI,
      functionName: 'takeSurplus',
      args: [amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    this.totalRedeemedUsdc += amount;
    this.logger.info(
      `Redeem surplus tx submitted: ${txHash} on ${networkName}`
    );
  }

  private async ensureAllowance(
    networkName: string,
    tokenAddress: string,
    spenderAddress: string,
    requiredAmount: bigint,
    minAllowance: bigint,
    tokenDecimals: number
  ): Promise<void> {
    const network = this.networkManager.getNetworkByName(networkName);
    if (!network) throw new Error(`Network ${networkName} not found`);

    const { publicClient, walletClient } =
      this.viemClientManager.getClients(network);

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

  // Public getters
  public getPoolData(networkName: string): PoolData | undefined {
    return this.poolData.get(networkName);
  }

  public getAllPoolData(): Map<string, PoolData> {
    return new Map(this.poolData);
  }

  public getTotalRedeemedUsdc(): bigint {
    return this.totalRedeemedUsdc;
  }

  public dispose(): void {
    for (const watcherId of this.watcherIds) {
      this.txReader.readContractWatcher.remove(watcherId);
    }
    this.watcherIds = [];
    this.poolData.clear();
    super.dispose();
    this.logger.debug('Rebalancer disposed');
  }
}
