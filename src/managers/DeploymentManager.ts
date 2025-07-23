import {
  DeploymentFetcher,
  ManagerBase,
  type LoggerInterface,
} from '@concero/operator-utils';
import type { Address } from 'viem';

export interface DeploymentManagerConfig {
  poolDeploymentsUrl: string;
  tokenDeploymentsUrl: string;
  poolPatterns: RegExp[];
  tokenPatterns: RegExp[];
}

export interface LancaDeployments {
  pools: Map<string, Address>;
  parentPool?: { network: string; address: Address };
  usdcTokens: Map<string, Address>;
  iouTokens: Map<string, Address>;
}

export class DeploymentManager extends ManagerBase {
  private static instance: DeploymentManager;
  private deployments: LancaDeployments = {
    pools: new Map(),
    parentPool: undefined,
    usdcTokens: new Map(),
    iouTokens: new Map(),
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
      this.logger.error('Failed to initialize DeploymentManager:', error);
      throw error;
    }
  }

  public async updateDeployments(): Promise<void> {
    try {
      const [poolDeployments, tokenDeployments] = await Promise.all([
        this.deploymentFetcher.getDeployments(
          this.config.poolDeploymentsUrl,
          this.config.poolPatterns
        ),
        this.deploymentFetcher.getDeployments(
          this.config.tokenDeploymentsUrl,
          this.config.tokenPatterns
        ),
      ]);

      this.parseDeployments(poolDeployments, tokenDeployments);
      this.logger.debug(
        `Updated deployments - Pools: ${this.deployments.pools.size}, USDC tokens: ${this.deployments.usdcTokens.size}, IOU tokens: ${this.deployments.iouTokens.size}`
      );
    } catch (error) {
      this.logger.error('Failed to update deployments:', error);
      throw error;
    }
  }

  private parseDeployments(
    poolDeployments: Array<{ key: string; value: string; networkName: string }>,
    tokenDeployments: Array<{ key: string; value: string; networkName: string }>
  ): void {
    // Clear existing deployments
    this.deployments.pools.clear();
    this.deployments.usdcTokens.clear();
    this.deployments.iouTokens.clear();
    this.deployments.parentPool = undefined;

    // Parse pool deployments
    for (const deployment of poolDeployments) {
      if (deployment.key.includes('PARENT_POOL')) {
        this.deployments.parentPool = {
          network: deployment.networkName,
          address: deployment.value as Address,
        };
        this.logger.debug(
          `Found parent pool on ${deployment.networkName}: ${deployment.value}`
        );
      } else if (deployment.key.includes('CHILD_POOL')) {
        this.deployments.pools.set(
          deployment.networkName,
          deployment.value as Address
        );
        this.logger.debug(
          `Found child pool on ${deployment.networkName}: ${deployment.value}`
        );
      }
    }

    // Parse token deployments
    for (const deployment of tokenDeployments) {
      if (deployment.key.includes('USDC_')) {
        this.deployments.usdcTokens.set(
          deployment.networkName,
          deployment.value as Address
        );
        this.logger.debug(
          `Found USDC token on ${deployment.networkName}: ${deployment.value}`
        );
      } else if (deployment.key.includes('IOU_')) {
        this.deployments.iouTokens.set(
          deployment.networkName,
          deployment.value as Address
        );
        this.logger.debug(
          `Found IOU token on ${deployment.networkName}: ${deployment.value}`
        );
      }
    }
  }

  public getDeployments(): LancaDeployments {
    return {
      pools: new Map(this.deployments.pools),
      parentPool: this.deployments.parentPool,
      usdcTokens: new Map(this.deployments.usdcTokens),
      iouTokens: new Map(this.deployments.iouTokens),
    };
  }

  public getPoolAddress(networkName: string): Address | undefined {
    return this.deployments.pools.get(networkName);
  }

  public getUsdcAddress(networkName: string): Address | undefined {
    return this.deployments.usdcTokens.get(networkName);
  }

  public getIouAddress(networkName: string): Address | undefined {
    return this.deployments.iouTokens.get(networkName);
  }

  public getParentPool(): { network: string; address: Address } | undefined {
    return this.deployments.parentPool;
  }

  public hasDeploymentsForNetwork(networkName: string): boolean {
    return this.deployments.pools.has(networkName);
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
