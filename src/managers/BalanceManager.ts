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

export interface TokenConfig {
    symbol: string;
    address: string;
    decimals: number;
}

export interface TokenBalance {
    native: bigint;
    tokens: Map<string, bigint>;
}

export interface BalanceManagerConfig {
    updateIntervalMs: number;
    minAllowances?: Map<string, Map<string, bigint>>;
    tokenDecimals?: Map<string, Map<string, number>>;
    tokens?: Map<string, TokenConfig[]>;
}

export abstract class BalanceManager extends ManagerBase implements NetworkUpdateListener {
    protected balances: Map<string, TokenBalance> = new Map();
    protected viemClientManager: IViemClientManager;
    protected txReader: ITxReader;
    protected logger: LoggerInterface;
    protected config: BalanceManagerConfig;
    protected activeNetworks: ConceroNetwork[] = [];
    protected watcherIds: string[] = [];
    protected minAllowances: Map<string, Map<string, bigint>> = new Map();
    protected tokenDecimals: Map<string, Map<string, number>> = new Map();
    protected tokenConfigs: Map<string, TokenConfig[]> = new Map();

    protected constructor(
        logger: LoggerInterface,
        viemClientManager: IViemClientManager,
        txReader: ITxReader,
        config: BalanceManagerConfig,
    ) {
        super();
        this.logger = logger;
        this.viemClientManager = viemClientManager;
        this.txReader = txReader;
        this.config = config;

        this.minAllowances = config.minAllowances || new Map();
        this.tokenDecimals = config.tokenDecimals || new Map();
        this.tokenConfigs = config.tokens || new Map();
    }

    public async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            this.logger.debug('Initialized');
        } catch (error) {
            this.logger.error(`Failed to initialize BalanceManager: ${error}`);
            throw error;
        }
    }

    public addTokenWatcher(
        network: ConceroNetwork,
        tokenSymbol: string,
        tokenAddress: Address,
    ): string {
        const accountAddress = this.getAccountAddress(network);

        const watcherId = this.txReader.readContractWatcher.create(
            tokenAddress,
            network,
            'balanceOf',
            ERC20_ABI,
            async (result: bigint) => {
                this.onTokenBalanceUpdate(network.name, tokenSymbol, result);
            },
            this.config.updateIntervalMs,
            [accountAddress],
        );

        this.watcherIds.push(watcherId);
        return watcherId;
    }

    protected getAccountAddress(network: ConceroNetwork): Address {
        const { account } = this.viemClientManager.getClients(network);
        return account.address;
    }

    protected onTokenBalanceUpdate(networkName: string, symbol: string, newBalance: bigint): void {
        const currentBalance = this.balances.get(networkName);
        if (!currentBalance) {
            const tokens = new Map();
            tokens.set(symbol, newBalance);
            this.balances.set(networkName, {
                native: 0n,
                tokens,
            });
        } else {
            const updatedBalance = { ...currentBalance };
            updatedBalance.tokens.set(symbol, newBalance);
            this.balances.set(networkName, updatedBalance);
        }

        console.table(this.balances);
    }

    public async updateBalances(networks: ConceroNetwork[]): Promise<void> {
        await this.updateNativeBalances(networks);
        await this.updateTokenBalances(networks);
    }
    protected async updateTokenBalances(networks: ConceroNetwork[]): Promise<void> {
        for (const network of networks) {
            const { publicClient, account } = this.viemClientManager.getClients(network);
            const networkName = network.name;

            const tokenConfigs = this.getTokenConfigs(networkName);

            if (tokenConfigs.length === 0) {
                this.logger.debug(`No tokens configured for network ${networkName}`);
                continue;
            }

            const currentBalance = this.balances.get(networkName);
            const tokens = new Map(currentBalance?.tokens || new Map());

            for (const tokenConfig of tokenConfigs) {
                try {
                    const balance = await this.fetchTokenBalance(
                        publicClient,
                        tokenConfig.address as Address,
                        account.address,
                    );
                    tokens.set(tokenConfig.symbol, balance);
                } catch (error) {
                    this.logger.error(
                        `Failed to get ${tokenConfig.symbol} balance for ${networkName}:`,
                        error,
                    );
                    tokens.set(tokenConfig.symbol, 0n);
                }
            }

            this.balances.set(networkName, {
                native: currentBalance?.native || 0n,
                tokens,
            });
        }
    }

    protected async fetchTokenBalance(
        publicClient: PublicClient,
        tokenAddress: Address,
        accountAddress: Address,
    ): Promise<bigint> {
        try {
            const balance = await publicClient.readContract({
                address: tokenAddress,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: [accountAddress],
            });

            return balance as bigint;
        } catch (error) {
            this.logger.error(`Failed to get token balance for ${tokenAddress}:`, error);
            return 0n;
        }
    }

    public getBalance(networkName: string): TokenBalance | undefined {
        return this.balances.get(networkName);
    }

    public getAllBalances(): Map<string, TokenBalance> {
        return new Map(this.balances);
    }

    public getTokenBalance(networkName: string, symbol: string): bigint {
        const balance = this.balances.get(networkName);
        return balance?.tokens.get(symbol) || 0n;
    }

    public getTotalTokenBalance(symbol: string): bigint {
        let total = 0n;
        for (const balance of this.balances.values()) {
            total += balance.tokens.get(symbol) || 0n;
        }
        return total;
    }

    public hasNativeBalance(networkName: string, minimumBalance: bigint = 0n): boolean {
        const balance = this.balances.get(networkName);
        return balance ? balance.native > minimumBalance : false;
    }

    public hasTokenBalance(
        networkName: string,
        symbol: string,
        minimumBalance: bigint = 0n,
    ): boolean {
        const balance = this.balances.get(networkName);
        return balance ? (balance.tokens.get(symbol) || 0n) > minimumBalance : false;
    }

    public registerToken(networkName: string, tokenConfig: TokenConfig): void {
        const existingTokens = this.tokenConfigs.get(networkName) || [];
        const updatedTokens = [...existingTokens, tokenConfig];
        this.tokenConfigs.set(networkName, updatedTokens);
    }

    public getTokenConfigs(networkName: string): TokenConfig[] {
        return this.tokenConfigs.get(networkName) || [];
    }

    public getTokenConfig(networkName: string, symbol: string): TokenConfig | undefined {
        const configs = this.tokenConfigs.get(networkName) || [];
        return configs.find(config => config.symbol === symbol);
    }

    public async onNetworksUpdated(networks: ConceroNetwork[]): Promise<void> {
        this.activeNetworks = networks;

        const activeNetworkNames = new Set(networks.map(n => n.name));
        for (const networkName of this.balances.keys()) {
            if (!activeNetworkNames.has(networkName)) {
                this.balances.delete(networkName);
                this.logger.debug(`Removed balance tracking for inactive network: ${networkName}`);
            }
        }

        await this.updateNativeBalances(networks);
    }

    public async forceUpdate(): Promise<void> {
        await this.updateBalances(this.activeNetworks);
        this.logger.debug('Force updated balances');
    }

    protected async updateNativeBalances(networks: ConceroNetwork[]): Promise<void> {
        const balancePromises = networks.map(async network => {
            try {
                const { publicClient, account } = this.viemClientManager.getClients(network);
                const nativeBalance = await publicClient.getBalance({
                    address: account.address,
                });

                const currentBalance = this.balances.get(network.name);
                const updatedBalance: TokenBalance = {
                    native: nativeBalance,
                    tokens: currentBalance?.tokens || new Map(),
                };

                this.balances.set(network.name, updatedBalance);
                return { network: network.name, success: true };
            } catch (error) {
                this.logger.error(`Failed to update native balance for ${network.name}:`, error);
                return { network: network.name, success: false, error };
            }
        });

        const results = await Promise.all(balancePromises);
        const failedNetworks = results.filter(r => !r.success);

        if (failedNetworks.length > 0) {
            this.logger.warn(
                `Failed to update native balances for ${failedNetworks.length} networks: ${failedNetworks.map(f => f.network).join(', ')}`,
            );
        }
    }

    public async ensureAllowance(
        networkName: string,
        tokenAddress: string,
        spenderAddress: string,
        requiredAmount: bigint,
    ): Promise<void> {
        const network = this.activeNetworks.find(n => n.name === networkName);
        if (!network) throw new Error(`Network ${networkName} not found or not active`);

        const minAmount = this.getMinAllowance(networkName, tokenAddress);
        const tokenDecimals = this.getTokenDecimals(networkName, tokenAddress);

        const { publicClient, walletClient } = this.viemClientManager.getClients(network);
        if (!walletClient) throw new Error(`No wallet client found for ${networkName}`);

        const currentAllowance = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [walletClient.account.address, spenderAddress as `0x${string}`],
        });

        if (currentAllowance >= requiredAmount) {
            const effectiveMinAmount = minAmount >= requiredAmount ? minAmount : requiredAmount;

            if (currentAllowance >= effectiveMinAmount) {
                this.logger.debug(
                    `Allowance sufficient: ${formatUnits(currentAllowance, tokenDecimals)} >= ${formatUnits(effectiveMinAmount, tokenDecimals)}`,
                );
                return;
            }

            const newAllowance = effectiveMinAmount;
            this.logger.info(
                `Increasing allowance from ${formatUnits(currentAllowance, tokenDecimals)} to ${formatUnits(newAllowance, tokenDecimals)} (minAmount: ${formatUnits(minAmount, tokenDecimals)})`,
            );

            const txHash = await walletClient.writeContract({
                address: tokenAddress as `0x${string}`,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [spenderAddress as `0x${string}`, newAllowance],
            });

            this.logger.info(`Approve tx submitted: ${txHash} on ${networkName}`);
            return;
        }

        const newAllowance = requiredAmount > minAmount ? requiredAmount : minAmount;
        this.logger.info(
            `Setting allowance: ${formatUnits(currentAllowance, tokenDecimals)} -> ${formatUnits(newAllowance, tokenDecimals)} (required: ${formatUnits(requiredAmount, tokenDecimals)}, min: ${formatUnits(minAmount, tokenDecimals)})`,
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
        spenderAddress: string,
    ): Promise<bigint> {
        const network = this.activeNetworks.find(n => n.name === networkName);
        if (!network) throw new Error(`Network ${networkName} not found or not active`);

        const { publicClient, walletClient } = this.viemClientManager.getClients(network);
        if (!walletClient) throw new Error(`No wallet client found for ${networkName}`);

        const allowance = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [walletClient.account.address, spenderAddress as `0x${string}`],
        });

        return allowance as bigint;
    }

    protected getMinAllowance(networkName: string, tokenAddress: string): bigint {
        const networkMap = this.minAllowances.get(networkName);
        if (!networkMap) return 0n;
        return networkMap.get(tokenAddress.toLowerCase()) || 0n;
    }

    protected getTokenDecimals(networkName: string, tokenAddress: string): number {
        const networkMap = this.tokenDecimals.get(networkName);
        if (!networkMap) return 18;
        return networkMap.get(tokenAddress.toLowerCase()) || 18;
    }

    protected clearTokenWatchers(): void {
        for (const watcherId of this.watcherIds) {
            this.txReader.readContractWatcher.remove(watcherId);
        }
        this.watcherIds = [];
    }

    public dispose(): void {
        this.clearTokenWatchers();
        this.balances.clear();
        super.dispose();
        this.logger.debug('Disposed');
    }
}
