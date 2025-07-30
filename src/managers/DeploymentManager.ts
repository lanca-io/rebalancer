import {
  DeploymentFetcher,
  ManagerBase,
  type LoggerInterface,
} from '@concero/operator-utils';
import type { Address } from 'viem';
import type { DeploymentUrls } from '../types/GlobalConfig';

export interface DeploymentManagerConfig {
  poolDeploymentUrls: DeploymentUrls;
  tokenDeploymentUrls: DeploymentUrls;
  poolPatterns: RegExp[];
  tokenPatterns: RegExp[];
  networkMode: 'mainnet' | 'testnet' | 'localhost';
  localhostDeployments?: LancaDeployments;
}

export interface LancaDeployments {
  pools: Record<string, Address>;
  parentPool: { network: string; address: Address };
  usdcTokens: Record<string, Address>;
  iouTokens: Record<string, Address>;
}

export class DeploymentManager extends ManagerBase {
  private static instance: DeploymentManager;
  private deployments: LancaDeployments = {
    pools: {},
    parentPool: { network: '', address: '' as Address },
    usdcTokens: {},
    iouTokens: {},
  };
  private deploymentFetcher: DeploymentFetcher;
  private logger: LoggerInterface;
  private config: DeploymentManagerConfig;
  private updateIntervalId: NodeJS.Timeout | null = null;

  private constructor(
    logger: LoggerInterface,
    config: DeploymentManagerConfig
  ) {
    super();
    this.logger = logger;
    this.config = config;
    this.deploymentFetcher = new DeploymentFetcher(logger);
  }

  public static createInstance(
    logger: LoggerInterface,
    config: DeploymentManagerConfig
  ): DeploymentManager {
    DeploymentManager.instance = new DeploymentManager(logger, config);
    return DeploymentManager.instance;
  }

  public static getInstance(): DeploymentManager {
    if (!DeploymentManager.instance) {
      throw new Error(
        'DeploymentManager is not initialized. Call createInstance() first.'
      );
    }
    return DeploymentManager.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.updateDeployments();
      this.initialized = true;
      this.logger.debug('Initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize DeploymentManager: ${error}`);
      throw error;
    }
  }

  public async updateDeployments(): Promise<void> {
    try {
      if (
        this.config.networkMode === 'localhost' &&
        this.config.localhostDeployments
      ) {
        // Use pre-configured localhost deployments
        this.logger.debug('Using localhost deployments');
        this.deployments = {
          pools: this.config.localhostDeployments.pools,
          parentPool: this.config.localhostDeployments.parentPool,
          usdcTokens: this.config.localhostDeployments.usdcTokens,
          iouTokens: this.config.localhostDeployments.iouTokens,
        };
      } else {
        // Normal flow - fetch from URLs based on network mode
        const networkKey = this.config.networkMode === 'mainnet' ? 'MAINNET' : 'TESTNET';
        const poolUrl = this.config.poolDeploymentUrls[networkKey];
        const tokenUrl = this.config.tokenDeploymentUrls[networkKey];
        
        const [poolDeployments, tokenDeployments] = await Promise.all([
          this.deploymentFetcher.getDeployments(poolUrl, this.config.poolPatterns),
          this.deploymentFetcher.getDeployments(tokenUrl, this.config.tokenPatterns),
        ]);

        this.parseDeployments(poolDeployments, tokenDeployments);
      }

      this.logger.debug(
        `Updated deployments - Pools: ${Object.keys(this.deployments.pools).length}, USDC tokens: ${Object.keys(this.deployments.usdcTokens).length}, IOU tokens: ${Object.keys(this.deployments.iouTokens).length}`
      );
    } catch (error) {
      this.logger.error(`Failed to update deployments: ${error}`);
      throw error;
    }
  }

  private parseDeployments(
    poolDeployments: Array<{ key: string; value: string; networkName: string }>,
    tokenDeployments: Array<{ key: string; value: string; networkName: string }>
  ): void {
    // Reset deployments
    this.deployments.pools = {};
    this.deployments.usdcTokens = {};
    this.deployments.iouTokens = {};

    let parentPoolFound = false;

    // Parse pool deployments
    for (const deployment of poolDeployments) {
      if (deployment.key.includes('PARENT_POOL')) {
        this.deployments.parentPool = {
          network: deployment.networkName,
          address: deployment.value as Address,
        };
        parentPoolFound = true;
        this.logger.debug(
          `Found parent pool on ${deployment.networkName}: ${deployment.value}`
        );
      } else if (deployment.key.includes('CHILD_POOL')) {
        this.deployments.pools[deployment.networkName] =
          deployment.value as Address;
        this.logger.debug(
          `Found child pool on ${deployment.networkName}: ${deployment.value}`
        );
      }
    }

    // Ensure parent pool is always found
    if (!parentPoolFound) {
      throw new Error('Parent pool deployment not found');
    }

    // Parse token deployments
    for (const deployment of tokenDeployments) {
      if (deployment.key.includes('USDC_')) {
        this.deployments.usdcTokens[deployment.networkName] =
          deployment.value as Address;
        this.logger.debug(
          `Found USDC token on ${deployment.networkName}: ${deployment.value}`
        );
      } else if (deployment.key.includes('IOU_')) {
        this.deployments.iouTokens[deployment.networkName] =
          deployment.value as Address;
        this.logger.debug(
          `Found IOU token on ${deployment.networkName}: ${deployment.value}`
        );
      }
    }
  }

  public getDeployments(): LancaDeployments {
    return {
      pools: { ...this.deployments.pools },
      parentPool: this.deployments.parentPool,
      usdcTokens: { ...this.deployments.usdcTokens },
      iouTokens: { ...this.deployments.iouTokens },
    };
  }

  public getPoolAddress(networkName: string): Address | undefined {
    return this.deployments.pools[networkName];
  }

  public getUsdcAddress(networkName: string): Address | undefined {
    return this.deployments.usdcTokens[networkName];
  }

  public getIouAddress(networkName: string): Address | undefined {
    return this.deployments.iouTokens[networkName];
  }

  public getParentPool(): { network: string; address: Address } {
    return this.deployments.parentPool;
  }

  public hasDeploymentsForNetwork(networkName: string): boolean {
    return networkName in this.deployments.pools;
  }

  public dispose(): void {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
    super.dispose();
    this.logger.debug('Disposed');
  }
}
