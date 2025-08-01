import { BalanceManager } from './BalanceManager';
import { LancaNetworkManager } from './LancaNetworkManager';
import { RebalanceOpportunity, RebalancerConfig } from './Rebalancer';

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
        const scoredOpportunities: ScoredOpportunity[] = [];

        for (const opportunity of opportunities) {
            const feasibility = await this.checkFeasibility(opportunity);
            const score = feasibility.feasible ? this.calculateScore(opportunity) : 0;

            scoredOpportunities.push({
                opportunity,
                score,
                feasible: feasibility.feasible,
                feasibilityReasons: feasibility.reasons,
            });

            // this.logger.debug(
            //   `Opportunity ${opportunity.type} on ${opportunity.toNetwork}: ` +
            //     `Score: ${score.toFixed(2)}, Feasible: ${feasibility.feasible}`
            // );
        }

        return scoredOpportunities
            .sort((a, b) => b.score - a.score)
            .filter(
                scored => scored.feasible && scored.score >= this.config.opportunityScorer.minScore,
            );
    }

    private async checkFeasibility(
        opportunity: RebalanceOpportunity,
    ): Promise<{ feasible: boolean; reasons: string[] }> {
        const reasons: string[] = [];

        if (opportunity.type === 'fillDeficit') {
            const balance = this.balanceManager.getBalance(opportunity.toNetwork);
            if (!balance || balance.usdc < opportunity.amount) {
                reasons.push(`Insufficient USDC balance`);
            }
        }

        if (opportunity.type === 'takeSurplus') {
            const balance = this.balanceManager.getBalance(opportunity.toNetwork);
            if (!balance || balance.iou < opportunity.amount) {
                reasons.push(`Insufficient IOU balance`);
            }
        }

        if (opportunity.type === 'bridgeIOU') {
            if (!opportunity.fromNetwork) {
                reasons.push(`Bridge operation requires fromNetwork`);
            } else {
                const balance = this.balanceManager.getBalance(opportunity.fromNetwork);
                if (!balance || balance.iou < opportunity.amount) {
                    reasons.push(`Insufficient IOU balance on source network`);
                }
            }
        }

        const networkName = opportunity.fromNetwork || opportunity.toNetwork;
        const hasGas = this.balanceManager.hasNativeBalance(networkName, 0n);
        if (!hasGas) {
            reasons.push(`Insufficient native gas on ${networkName}`);
        }

        return { feasible: reasons.length === 0, reasons };
    }

    private calculateScore(opportunity: RebalanceOpportunity): number {
        const baseWeight = OPPORTUNITY_WEIGHTS[opportunity.type];
        const costFactor = this.calculateCostFactor(opportunity);
        const score = baseWeight * costFactor;

        // this.logger.debug(
        //   `Score calculation for ${opportunity.type}: ` +
        //     `base=${baseWeight}, cost=${costFactor.toFixed(2)}, final=${score.toFixed(2)}`
        // );

        return score;
    }

    private calculateCostFactor(opportunity: RebalanceOpportunity): number {
        const gasCostUSD = 1;
        let totalCostUSD = gasCostUSD;

        if (opportunity.type === 'bridgeIOU' && opportunity.fromNetwork) {
            const bridgeFee = this.getBridgeFee(opportunity.fromNetwork, opportunity.toNetwork);
            totalCostUSD += Number(formatUnits(bridgeFee, USDC_DECIMALS));
        }

        const opportunityValueUSD = Number(formatUnits(opportunity.amount, USDC_DECIMALS));
        const costRatio = totalCostUSD / opportunityValueUSD;

        return Math.max(0.1, 1.0 - costRatio);
    }

    private getBridgeFee(_fromNetwork: string, _toNetwork: string): bigint {
        return 0n;
    }
}
