import type { DeploymentManager } from './DeploymentManager';
import type { LancaNetworkManager } from './LancaNetworkManager';
import { OpportunityScorer, PoolData, ScoredOpportunity } from './OpportunityScroer';

import { BalanceManager, IBalanceManager, ManagerBase } from '@concero/operator-utils';
import type {
    ITxMonitor,
    ITxReader,
    ITxWriter,
    IViemClientManager,
    LoggerInterface,
} from '@concero/operator-utils';
import { formatUnits } from 'viem';

import { IOU_TOKEN_DECIMALS, FULL_LBF_ABI as LBF_ABI, USDC_DECIMALS } from '../constants';

export interface RebalancerConfig {
    deficitThreshold: bigint;
    surplusThreshold: bigint;
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
    private bulkId?: string;
    private totalRedeemedUsdc: bigint = 0n;
    private opportunityScorer: OpportunityScorer;

    private txReader: ITxReader;
    private txWriter: ITxWriter;
    private txMonitor: ITxMonitor;
    private viemClientManager: IViemClientManager;
    private balanceManager: IBalanceManager;
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
        balanceManager: IBalanceManager,
        deploymentManager: DeploymentManager,
        networkManager: LancaNetworkManager,
        config: RebalancerConfig,
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
            config,
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
        config: RebalancerConfig,
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
            config,
        );
        return Rebalancer.instance;
    }

    public static getInstance(): Rebalancer {
        if (!Rebalancer.instance) {
            throw new Error('Rebalancer is not initialized. Call createInstance() first.');
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

        const items: Parameters<ITxReader['readContractWatcher']['bulkCreate']>[0] = networks
            .map(n => {
                const address =
                    n.name === parentPoolNetwork
                        ? deployments.parentPool.address
                        : deployments.pools[n.name];

                if (!address) {
                    this.logger.warn(`No pool address for network ${n.name}`);
                    return null;
                }

                return {
                    contractAddress: address,
                    network: n,
                    functionName: 'getPoolData',
                    abi: LBF_ABI,
                };
            })
            .filter(Boolean) as NonNullable<ReturnType<typeof Array.prototype.filter>>;

        const { bulkId } = this.txReader.readContractWatcher.bulkCreate(
            items,
            {},
            async ({ results, errors }) => {
                for (const err of errors) {
                    this.logger.error(`getPoolData failed on ${err.network.name}: ${err.error}`);
                }

                for (const { network, value } of results) {
                    const [deficit, surplus] = value as [bigint, bigint];
                    await this.onPoolDataUpdate(network.name, deficit, surplus);
                }
            },
        );

        this.bulkId = bulkId;
    }

    private async onPoolDataUpdate(
        networkName: string,
        deficit: bigint,
        surplus: bigint,
    ): Promise<void> {
        this.poolData.set(networkName, {
            deficit,
            surplus,
            lastUpdated: new Date(),
        });

        this.logger.debug(
            `Pool ${networkName}: ` +
                `Deficit ${formatUnits(deficit, USDC_DECIMALS)} USDC, ` +
                `Surplus ${formatUnits(surplus, USDC_DECIMALS)} USDC`,
        );

        await this.checkRebalancingOpportunities();
    }

    private async checkRebalancingOpportunities(): Promise<void> {
        const allOpportunities = this.discoverOpportunities();

        if (allOpportunities.length === 0) return;

        const scoredOpportunities =
            await this.opportunityScorer.scoreAndFilterOpportunities(allOpportunities);

        if (scoredOpportunities.length === 0) {
            this.logger.info('No feasible opportunities after scoring');
            return;
        }

        this.logger.info(`Found ${scoredOpportunities.length} feasible opportunities:`);
        scoredOpportunities.forEach((scored, index) => {
            this.logger.info(
                `  ${index + 1}. ${scored.opportunity.type} (Score: ${scored.score.toFixed(2)}): ${scored.opportunity.reason}`,
            );
        });

        await this.executeOpportunities(scoredOpportunities);
    }

    private discoverOpportunities(): RebalanceOpportunity[] {
        const opportunities: RebalanceOpportunity[] = [];

        // 1. Deficit filling opportunities
        for (const [networkName, data] of this.poolData) {
            if (data.deficit >= this.config.deficitThreshold) {
                const usdcBalance = this.balanceManager.getTokenBalance(networkName, 'USDC');
                if (usdcBalance > 0n) {
                    const fillAmount = usdcBalance < data.deficit ? usdcBalance : data.deficit;

                    opportunities.push({
                        type: 'fillDeficit',
                        toNetwork: networkName,
                        amount: fillAmount,
                        reason: `Fill deficit of ${formatUnits(data.deficit, USDC_DECIMALS)} USDC`,
                    });
                }
            }
        }

        // 2. Surplus redemption opportunities
        for (const [networkName, data] of this.poolData) {
            if (data.surplus >= this.config.surplusThreshold) {
                const iouBalance = this.balanceManager.getTokenBalance(networkName, 'IOU');
                if (iouBalance > 0n) {
                    const redeemAmount = iouBalance < data.surplus ? iouBalance : data.surplus;
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
        const candidateNetworks = this.networkManager
            .getActiveNetworks()
            .map(n => {
                const iouBalance = this.balanceManager.getTokenBalance(n.name, 'IOU');
                const pool = this.poolData.get(n.name);
                const hasLocalDeficit = pool ? pool.deficit >= this.config.deficitThreshold : false;
                const hasLocalSurplus = pool ? pool.surplus >= this.config.surplusThreshold : false;
                return {
                    network: n.name,
                    iouBalance,
                    eligible: iouBalance > 0n && !hasLocalDeficit && !hasLocalSurplus,
                };
            })
            .filter(x => x.eligible);

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

    private async executeOpportunities(scoredOpportunities: ScoredOpportunity[]): Promise<void> {
        for (const scored of scoredOpportunities) {
            try {
                await this.executeOpportunity(scored.opportunity);
            } catch (error) {
                this.logger.error(`Failed to execute opportunity: ${error}`);
            }
        }
    }

    private async executeOpportunity(opportunity: RebalanceOpportunity): Promise<void> {
        this.logger.info(`Executing ${opportunity.type}: ${opportunity.reason}`);

        switch (opportunity.type) {
            case 'fillDeficit':
                await this.fillDeficit(opportunity.toNetwork, opportunity.amount);
                break;
            case 'bridgeIOU':
                await this.bridgeIOU(
                    opportunity.fromNetwork!,
                    opportunity.toNetwork,
                    opportunity.amount,
                );
                break;
            case 'takeSurplus':
                await this.takeSurplus(opportunity.toNetwork, opportunity.amount);
                break;
        }

        await this.balanceManager.forceUpdate();
    }

    private async fillDeficit(networkName: string, amount: bigint): Promise<void> {
        const network = this.networkManager.getNetworkByName(networkName);
        if (!network) throw new Error(`Network ${networkName} not found`);

        const poolAddress = this.deploymentManager.getPoolAddress(networkName);
        if (!poolAddress) throw new Error(`Pool address not found for ${networkName}`);

        const usdcAddress = this.deploymentManager.getUsdcAddress(networkName);
        if (!usdcAddress) throw new Error(`USDC address not found for ${networkName}`);

        await this.balanceManager.ensureAllowance(networkName, usdcAddress, poolAddress, amount);

        const { walletClient, publicClient } = this.viemClientManager.getClients(network);
        if (!walletClient) throw new Error(`No wallet client found for ${networkName}`);

        const txHash = await walletClient.writeContract({
            address: poolAddress as `0x${string}`,
            abi: LBF_ABI,
            functionName: 'fillDeficit',
            args: [amount],
            gas: 1_000_000,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });

        this.logger.info(
            `Fill deficit of ${formatUnits(amount, USDC_DECIMALS)} USDC tx submitted: ${txHash} on ${networkName}`,
        );
    }

    private async bridgeIOU(fromNetwork: string, toNetwork: string, amount: bigint): Promise<void> {
        const sourceNetwork = this.networkManager.getNetworkByName(fromNetwork);
        const destNetwork = this.networkManager.getNetworkByName(toNetwork);
        if (!sourceNetwork || !destNetwork) {
            throw new Error(`Network not found: ${!sourceNetwork ? fromNetwork : toNetwork}`);
        }

        const poolAddress = this.deploymentManager.getPoolAddress(fromNetwork);
        if (!poolAddress) throw new Error(`Pool address not found for ${fromNetwork}`);

        const iouAddress = this.deploymentManager.getIouAddress(fromNetwork);
        if (!iouAddress) throw new Error(`IOU address not found for ${fromNetwork}`);

        await this.balanceManager.ensureAllowance(fromNetwork, iouAddress, poolAddress, amount);

        const { walletClient, publicClient } = this.viemClientManager.getClients(sourceNetwork);
        if (!walletClient) throw new Error(`No wallet client found for ${fromNetwork}`);

        const txHash = await walletClient.writeContract({
            address: poolAddress as `0x${string}`,
            abi: LBF_ABI,
            functionName: 'bridgeIOU',
            args: [amount, BigInt(destNetwork.id)],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });

        this.logger.info(
            `Bridge IOU of ${formatUnits(amount, IOU_TOKEN_DECIMALS)} IOU tx submitted: ${txHash} from ${fromNetwork} to ${toNetwork}`,
        );
    }

    private async takeSurplus(networkName: string, amount: bigint): Promise<void> {
        this.logger.info(
            `Taking USDC surplus in exchange for ${amount} IOU tokens on ${networkName}`,
        );
        const network = this.networkManager.getNetworkByName(networkName);
        if (!network) throw new Error(`Network ${networkName} not found`);

        const poolAddress = this.deploymentManager.getPoolAddress(networkName);
        if (!poolAddress) throw new Error(`Pool address not found for ${networkName}`);

        const iouAddress = this.deploymentManager.getIouAddress(networkName);
        if (!iouAddress) throw new Error(`IOU address not found for ${networkName}`);

        await this.balanceManager.ensureAllowance(networkName, iouAddress, poolAddress, amount);

        const { walletClient, publicClient } = this.viemClientManager.getClients(network);
        if (!walletClient) throw new Error(`No wallet client found for ${networkName}`);

        const txHash = await walletClient.writeContract({
            address: poolAddress as `0x${string}`,
            abi: LBF_ABI,
            functionName: 'takeSurplus',
            args: [amount],
            gasLimit: 1_000_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });

        this.totalRedeemedUsdc += amount;
        this.logger.info(
            `Redeem surplus of ${formatUnits(amount, IOU_TOKEN_DECIMALS)} IOU tx submitted: ${txHash} on ${networkName}`,
        );
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
        if (this.bulkId) {
            this.txReader.readContractWatcher.removeBulk(this.bulkId);
            this.bulkId = undefined;
        }
        this.poolData.clear();
        super.dispose();
        this.logger.debug('Rebalancer disposed');
    }
}
