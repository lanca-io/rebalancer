import type { DeploymentManager } from './DeploymentManager';

import { ManagerBase } from '@concero/operator-utils';
import type { ConceroNetwork } from '@concero/operator-utils/src/types/ConceroNetwork';
import type { LoggerInterface } from '@concero/operator-utils/src/types/LoggerInterface';
import type {
    IConceroNetworkManager,
    INetworkManager,
    NetworkUpdateListener,
} from '@concero/operator-utils/src/types/managers';

export interface LancaNetworkManagerConfig {
    networkUpdateIntervalMs: number;
    whitelistedNetworkIds?: number[];
    blacklistedNetworkIds?: number[];
    networkMode: 'mainnet' | 'testnet' | 'localhost';
    localhostNetworks?: ConceroNetwork[];
}

export class LancaNetworkManager extends ManagerBase implements IConceroNetworkManager {
    private static instance: LancaNetworkManager;
    private conceroNetworkManager: INetworkManager;
    private deploymentManager: DeploymentManager;
    private activeNetworks: ConceroNetwork[] = [];
    private updateListeners: NetworkUpdateListener[] = [];
    private updateIntervalId: NodeJS.Timeout | null = null;
    private logger: LoggerInterface;
    private config: LancaNetworkManagerConfig;

    private constructor(
        logger: LoggerInterface,
        conceroNetworkManager: INetworkManager,
        deploymentManager: DeploymentManager,
        config: LancaNetworkManagerConfig,
    ) {
        super();
        this.logger = logger;
        this.conceroNetworkManager = conceroNetworkManager;
        this.deploymentManager = deploymentManager;
        this.config = config;
    }

    public static createInstance(
        logger: LoggerInterface,
        conceroNetworkManager: INetworkManager,
        deploymentManager: DeploymentManager,
        config: LancaNetworkManagerConfig,
    ): LancaNetworkManager {
        LancaNetworkManager.instance = new LancaNetworkManager(
            logger,
            conceroNetworkManager,
            deploymentManager,
            config,
        );
        return LancaNetworkManager.instance;
    }

    public static getInstance(): LancaNetworkManager {
        if (!LancaNetworkManager.instance) {
            throw new Error('LancaNetworkManager is not initialized. Call createInstance() first.');
        }
        return LancaNetworkManager.instance;
    }

    public async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            // Perform initial update
            await this.updateActiveNetworks();

            // Start update cycle
            this.startUpdateCycle();

            this.initialized = true;
            this.logger.debug('Initialized');
        } catch (error) {
            this.logger.error(`Failed to initialize LancaNetworkManager: ${error}`);
            throw error;
        }
    }

    private startUpdateCycle(): void {
        if (this.updateIntervalId) {
            clearInterval(this.updateIntervalId);
        }

        this.updateIntervalId = setInterval(
            () =>
                this.updateActiveNetworks().catch(err =>
                    this.logger.error(`Network update failed: ${err}`),
                ),
            this.config.networkUpdateIntervalMs,
        );

        this.logger.debug(
            `Started network update cycle with interval: ${this.config.networkUpdateIntervalMs}ms`,
        );
    }

    private async updateActiveNetworks(): Promise<void> {
        try {
            let conceroNetworks: ConceroNetwork[];

            if (this.config.networkMode === 'localhost' && this.config.localhostNetworks) {
                this.logger.debug('Using localhost networks');
                conceroNetworks = this.config.localhostNetworks;
            } else {
                this.logger.debug('Triggering ConceroNetworkManager update');
                await this.conceroNetworkManager.forceUpdate();
                conceroNetworks = this.conceroNetworkManager.getActiveNetworks();
                this.logger.debug(
                    `ConceroNetworkManager returned ${conceroNetworks.length} networks`,
                );
            }

            this.logger.debug('Updating deployments');
            await this.deploymentManager.updateDeployments();

            const deployments = this.deploymentManager.getDeployments();

            // Filter networks based on deployments and config
            const filteredNetworks = conceroNetworks.filter(network => {
                const hasPoolDeployment = network.name in deployments.pools;
                const isParentPoolNetwork = network.name === deployments.parentPool.network;

                if (!hasPoolDeployment && !isParentPoolNetwork) {
                    this.logger.debug(
                        `Excluding ${network.name} - no pool deployment and not parent pool network`,
                    );
                    return false;
                }

                // Apply whitelist
                if (
                    this.config.whitelistedNetworkIds &&
                    this.config.whitelistedNetworkIds.length > 0
                ) {
                    const isWhitelisted = this.config.whitelistedNetworkIds.includes(network.id);
                    if (!isWhitelisted) {
                        this.logger.debug(`Excluding ${network.name} - not in whitelist`);
                    }
                    return isWhitelisted;
                }

                // Apply blacklist
                if (
                    this.config.blacklistedNetworkIds &&
                    this.config.blacklistedNetworkIds.includes(network.id)
                ) {
                    this.logger.debug(`Excluding ${network.name} - in blacklist`);
                    return false;
                }

                return true;
            });

            // Check if networks have changed
            const hasChanged = this.hasNetworksChanged(filteredNetworks);

            if (hasChanged) {
                this.activeNetworks = filteredNetworks;
                this.logger.info(
                    `Active networks updated: ${this.activeNetworks.length} networks (${this.activeNetworks.map(n => n.name).join(', ')})`,
                );

                // Notify all registered listeners
                await this.notifyListeners();
            } else {
                this.logger.debug('No network changes detected');
            }
        } catch (error) {
            this.logger.error(`Failed to update active networks: ${error}`);
            throw error;
        }
    }

    private hasNetworksChanged(newNetworks: ConceroNetwork[]): boolean {
        if (newNetworks.length !== this.activeNetworks.length) return true;

        const currentIds = new Set(this.activeNetworks.map(n => n.id));
        const newIds = new Set(newNetworks.map(n => n.id));

        for (const id of newIds) {
            if (!currentIds.has(id)) return true;
        }

        return false;
    }

    private async notifyListeners(): Promise<void> {
        this.logger.debug(`Notifying ${this.updateListeners.length} listeners of network updates`);

        for (const listener of this.updateListeners) {
            try {
                this.logger.debug(`Notifying ${listener.constructor.name} of network updates`);
                await listener.onNetworksUpdated(this.activeNetworks);
            } catch (error) {
                this.logger.error(
                    `Error in network update listener ${listener.constructor.name}: ${error}`,
                );
            }
        }
    }

    public registerUpdateListener(listener: NetworkUpdateListener): void {
        const existingIndex = this.updateListeners.findIndex(
            existing => existing.constructor.name === listener.constructor.name,
        );

        if (existingIndex === -1) {
            this.updateListeners.push(listener);
            this.logger.debug(`Registered update listener: ${listener.constructor.name}`);
        } else {
            this.logger.warn(`Update listener already registered: ${listener.constructor.name}`);
        }
    }

    public unregisterUpdateListener(listener: NetworkUpdateListener): void {
        const index = this.updateListeners.indexOf(listener);
        if (index !== -1) {
            this.updateListeners.splice(index, 1);
            this.logger.debug(`Unregistered update listener: ${listener.constructor.name}`);
        }
    }

    public async triggerInitialUpdates(): Promise<void> {
        this.logger.debug('Triggering initial updates for all listeners');

        // First ensure we have the latest networks
        await this.updateActiveNetworks();

        // Then notify all listeners
        for (const listener of this.updateListeners) {
            try {
                this.logger.debug(`Triggering initial update for ${listener.constructor.name}`);
                await listener.onNetworksUpdated(this.activeNetworks);
                this.logger.debug(`Completed initial update for ${listener.constructor.name}`);
            } catch (error) {
                this.logger.error(
                    `Error in initial update for ${listener.constructor.name}: ${error}`,
                );
                throw error;
            }
        }

        this.logger.debug('Completed all initial updates');
    }

    public getActiveNetworks(): ConceroNetwork[] {
        return this.activeNetworks;
    }

    public getNetworkByName(name: string): ConceroNetwork {
        const network = this.activeNetworks.find(network => network.name === name);
        if (!network) {
            throw new Error(`Network with name ${name} not found`);
        }
        return network;
    }

    public getNetworkById(chainId: number): ConceroNetwork {
        const network = this.activeNetworks.find(network => network.id === chainId);
        if (!network) {
            throw new Error(`Network with chainId ${chainId} not found`);
        }
        return network;
    }

    public getNetworkBySelector(selector: string): ConceroNetwork {
        const network = this.activeNetworks.find(network => network.chainSelector === selector);
        if (!network) {
            throw new Error(`Network with selector ${selector} not found`);
        }
        return network;
    }

    public async forceUpdate(): Promise<void> {
        this.logger.debug('Force update requested');
        await this.updateActiveNetworks();
    }

    // IConceroNetworkManager interface implementation
    public getMainnetNetworks(): Record<string, ConceroNetwork> {
        const networks: Record<string, ConceroNetwork> = {};
        this.activeNetworks
            .filter(network => network.mode === 'mainnet')
            .forEach(network => {
                networks[network.name] = network;
            });
        return networks;
    }

    public getTestnetNetworks(): Record<string, ConceroNetwork> {
        const networks: Record<string, ConceroNetwork> = {};
        this.activeNetworks
            .filter(network => network.mode === 'testnet')
            .forEach(network => {
                networks[network.name] = network;
            });
        return networks;
    }

    public getAllNetworks(): Record<string, ConceroNetwork> {
        const networks: Record<string, ConceroNetwork> = {};
        this.activeNetworks.forEach(network => {
            networks[network.name] = network;
        });
        return networks;
    }

    public getVerifierNetwork(): ConceroNetwork | undefined {
        return this.conceroNetworkManager.getVerifierNetwork();
    }

    public dispose(): void {
        if (this.updateIntervalId) {
            clearInterval(this.updateIntervalId);
            this.updateIntervalId = null;
        }
        this.updateListeners = [];
        super.dispose();
        this.logger.debug('Disposed');
    }
}
