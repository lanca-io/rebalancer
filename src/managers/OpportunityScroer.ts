import { LoggerInterface } from '@concero/operator-utils';
import { USDC_DECIMALS } from 'src/constants';
import { formatUnits } from 'viem';
import { BalanceManager } from './BalanceManager';
import { LancaNetworkManager } from './LancaNetworkManager';
import { RebalanceOpportunity, RebalancerConfig } from './Rebalancer';

// Scoring constants
const OPPORTUNITY_WEIGHTS = {
  fillDeficit: 100, // High priority - enables future fee earning
  takeSurplus: 100, // High priority - actually earns fees
  bridgeIOU: 40, // Lower priority - costly operation
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
    private readonly config: RebalancerConfig
  ) {}

  public async scoreAndFilterOpportunities(
    opportunities: RebalanceOpportunity[]
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

      this.logger.debug(
        `Opportunity ${opportunity.type} on ${opportunity.toNetwork}: ` +
          `Score: ${score.toFixed(2)}, Feasible: ${feasibility.feasible}`
      );
    }

    return scoredOpportunities
      .sort((a, b) => b.score - a.score)
      .filter(
        (scored) =>
          scored.feasible &&
          scored.score >= this.config.opportunityScorer.minScore
      );
  }

  private async checkFeasibility(
    opportunity: RebalanceOpportunity
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
    const urgencyMultiplier = this.calculateUrgencyMultiplier(opportunity);
    const costFactor = this.calculateCostFactor(opportunity);

    const score = baseWeight * urgencyMultiplier * costFactor;

    this.logger.debug(
      `Score calculation for ${opportunity.type}: ` +
        `base=${baseWeight}, urgency=${urgencyMultiplier.toFixed(2)}, ` +
        `cost=${costFactor.toFixed(2)}, final=${score.toFixed(2)}`
    );

    return score;
  }

  private calculateUrgencyMultiplier(
    opportunity: RebalanceOpportunity
  ): number {
    if (opportunity.type === 'fillDeficit') {
      const ratio =
        Number(opportunity.amount) / Number(this.config.deficitThreshold);
      return Math.min(2.0, 1.0 + ratio * 0.5); // Max 2x multiplier
    }

    if (opportunity.type === 'takeSurplus') {
      const ratio =
        Number(opportunity.amount) / Number(this.config.surplusThreshold);
      return Math.min(1.5, 1.0 + ratio * 0.3); // Max 1.5x multiplier
    }

    return 1.0; // Base multiplier for bridgeIOU
  }

  private calculateCostFactor(opportunity: RebalanceOpportunity): number {
    const gasEstimate = 1;
    const gasCostUSD = 1;

    let totalCostUSD = gasCostUSD;

    // Add bridge fees for bridge operations
    if (opportunity.type === 'bridgeIOU' && opportunity.fromNetwork) {
      const bridgeFee = this.getBridgeFee(
        opportunity.fromNetwork,
        opportunity.toNetwork
      );
      totalCostUSD += Number(formatUnits(bridgeFee, USDC_DECIMALS));
    }

    // Calculate cost as percentage of opportunity value
    const opportunityValueUSD = Number(
      formatUnits(opportunity.amount, USDC_DECIMALS)
    );
    const costRatio = totalCostUSD / opportunityValueUSD;

    // Return inverse cost factor (lower cost = higher score)
    return Math.max(0.1, 1.0 - costRatio);
  }

  private getBridgeFee(fromNetwork: string, toNetwork: string): bigint {
    return 0n;
  }
}
