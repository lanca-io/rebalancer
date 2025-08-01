import { BalanceManager, type BalanceManagerConfig } from './BalanceManager';
import type { DeploymentManager } from './DeploymentManager';

import type { ConceroNetwork } from '@concero/operator-utils/src/types/ConceroNetwork';
import type { LoggerInterface } from '@concero/operator-utils/src/types/LoggerInterface';
import type { ITxReader, IViemClientManager } from '@concero/operator-utils/src/types/managers';

export class LancaBalanceManager extends BalanceManager {
    private static instance: LancaBalanceManager;
    private deploymentManager: DeploymentManager;

    private constructor(
        logger: LoggerInterface,
        viemClientManager: IViemClientManager,
        deploymentManager: DeploymentManager,
        txReader: ITxReader,
        config: BalanceManagerConfig,
    ) {
        super(logger, viemClientManager, txReader, config);
        this.deploymentManager = deploymentManager;
    }

    public static createInstance(
        logger: LoggerInterface,
        viemClientManager: IViemClientManager,
        deploymentManager: DeploymentManager,
        txReader: ITxReader,
        config: BalanceManagerConfig,
    ): LancaBalanceManager {
        LancaBalanceManager.instance = new LancaBalanceManager(
            logger,
            viemClientManager,
            deploymentManager,
            txReader,
            config,
        );
        return LancaBalanceManager.instance;
    }

    public static getInstance(): LancaBalanceManager {
        if (!LancaBalanceManager.instance) {
            throw new Error('LancaBalanceManager is not initialized. Call createInstance() first.');
        }
        return LancaBalanceManager.instance;
    }

    protected async setupTokenWatchers(): Promise<void> {
        this.clearTokenWatchers();

        const deployments = this.deploymentManager.getDeployments();
        let watcherCount = 0;

        for (const network of this.activeNetworks) {
            const networkName = network.name;
            const usdcAddress = deployments.usdcTokens[networkName];
            const iouAddress = deployments.iouTokens[networkName];

            if (usdcAddress) {
                this.addTokenWatcher(network, 'USDC', usdcAddress);
                watcherCount++;
            }

            if (iouAddress) {
                this.addTokenWatcher(network, 'IOU', iouAddress);
                watcherCount++;
            }
        }

        this.logger.debug(
            `Started ${watcherCount} token watchers (USDC/IOU) for ${this.activeNetworks.length} networks`,
        );
    }

    public async onNetworksUpdated(networks: ConceroNetwork[]): Promise<void> {
        await super.onNetworksUpdated(networks);

        this.clearTokenWatchers();
        this.setupTokenWatchers();

        this.logger.debug('LancaBalanceManager updated networks and token watchers');
    }

    public async ensureTokenAllowance(
        networkName: string,
        tokenSymbol: string,
        spenderAddress: string,
        requiredAmount: bigint,
    ): Promise<void> {
        const deployments = this.deploymentManager.getDeployments();
        let tokenAddress: string;

        if (tokenSymbol === 'USDC') {
            tokenAddress = deployments.usdcTokens[networkName];
        } else if (tokenSymbol === 'IOU') {
            tokenAddress = deployments.iouTokens[networkName];
        } else {
            throw new Error(`Unknown token symbol: ${tokenSymbol}`);
        }

        if (!tokenAddress) {
            throw new Error(`${tokenSymbol} token address not found for network ${networkName}`);
        }

        await this.ensureAllowance(networkName, tokenAddress, spenderAddress, requiredAmount);
    }

    public async getTokenAllowance(
        networkName: string,
        tokenSymbol: string,
        spenderAddress: string,
    ): Promise<bigint> {
        const deployments = this.deploymentManager.getDeployments();
        let tokenAddress: string;

        if (tokenSymbol === 'USDC') {
            tokenAddress = deployments.usdcTokens[networkName];
        } else if (tokenSymbol === 'IOU') {
            tokenAddress = deployments.iouTokens[networkName];
        } else {
            throw new Error(`Unknown token symbol: ${tokenSymbol}`);
        }

        if (!tokenAddress) {
            throw new Error(`${tokenSymbol} token address not found for network ${networkName}`);
        }

        return this.getAllowance(networkName, tokenAddress, spenderAddress);
    }
}
