// ← same instance Rebalancer uses
import { LancaNetworkManager } from './LancaNetworkManager';
import { RebalanceOpportunity, RebalancerConfig } from './Rebalancer';

import { BalanceManager } from '@concero/operator-utils';
import { LoggerInterface } from '@concero/operator-utils';
import { USDC_DECIMALS } from 'src/constants';
import { formatUnits } from 'viem';

const OPPORTUNITY_WEIGHTS = {
    fillDeficit: 200,
    takeSurplus: 200,
    bridgeIOU: 40,
} as const;

export interface PoolData {
    deficit: bigint;
    surplus: bigint;
    lastUpdated: Date;
}

export interface ScoredOpportunity {
    opportunity: RebalanceOpportunity;
    score: number;
    feasible: boolean;
    feasibilityReasons: string[];
}

export class OpportunityScorer {
    constructor(
        private readonly logger: LoggerInterface,
        private readonly balanceManager: BalanceManager,
        private readonly networkManager: LancaNetworkManager,
        private readonly config: RebalancerConfig,
    ) {}

    public async scoreAndFilterOpportunities(
        opportunities: RebalanceOpportunity[],
    ): Promise<ScoredOpportunity[]> {
        const scored: ScoredOpportunity[] = [];

        for (const opp of opportunities) {
            const { feasible, reasons } = await this.checkFeasibility(opp);
            const score = feasible ? this.calculateScore(opp) : 0;

            scored.push({ opportunity: opp, score, feasible, feasibilityReasons: reasons });
        }

        return scored
            .filter(s => s.feasible && s.score >= this.config.opportunityScorer.minScore)
            .sort((a, b) => b.score - a.score);
    }

    private async checkFeasibility(
        opp: RebalanceOpportunity,
    ): Promise<{ feasible: boolean; reasons: string[] }> {
        const reasons: string[] = [];

        switch (opp.type) {
            case 'fillDeficit': {
                const usdc = this.balanceManager.getTokenBalance(opp.toNetwork, 'USDC');
                if (usdc < opp.amount) reasons.push('Insufficient USDC balance');
                break;
            }

            case 'takeSurplus': {
                const iou = this.balanceManager.getTokenBalance(opp.toNetwork, 'IOU');
                if (iou < opp.amount) reasons.push('Insufficient IOU balance');
                break;
            }

            case 'bridgeIOU': {
                if (!opp.fromNetwork) {
                    reasons.push('Bridge operation requires fromNetwork');
                } else {
                    const iou = this.balanceManager.getTokenBalance(opp.fromNetwork, 'IOU');
                    if (iou < opp.amount)
                        reasons.push('Insufficient IOU balance on source network');
                }
                break;
            }
        }

        const gasNetwork = opp.fromNetwork ?? opp.toNetwork;
        const nativeGas = this.balanceManager.getNativeBalances().get(gasNetwork) ?? 0n;
        if (nativeGas === 0n) reasons.push(`Insufficient native gas on ${gasNetwork}`);

        return { feasible: reasons.length === 0, reasons };
    }

    private calculateScore(opp: RebalanceOpportunity): number {
        const base = OPPORTUNITY_WEIGHTS[opp.type];
        return base * this.calculateCostFactor(opp);
    }

    private calculateCostFactor(opp: RebalanceOpportunity): number {
        const gasCostUSD = 1; // rough, constant
        let totalCostUSD = gasCostUSD;

        if (opp.type === 'bridgeIOU' && opp.fromNetwork) {
            const bridgeFee = this.getBridgeFee(opp.fromNetwork, opp.toNetwork);
            totalCostUSD += Number(formatUnits(bridgeFee, USDC_DECIMALS));
        }

        const valueUSD = Number(formatUnits(opp.amount, USDC_DECIMALS));
        const ratio = totalCostUSD / valueUSD;

        return Math.max(0.1, 1 - ratio);
    }

    private getBridgeFee(_from: string, _to: string): bigint {
        return 0n;
    }
}
