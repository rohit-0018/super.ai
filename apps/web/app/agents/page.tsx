'use client';
import AgentsPanel from '../../components/AgentsPanel';
import LearningAgentCard from '../../components/LearningAgentCard';
import AlertsFeed from '../../components/AlertsFeed';

export default function AgentsPage() {
  return (
    <div className="page space-y-4">
      <header>
        <div className="section-eyebrow">Agents</div>
        <h1 className="page-title">Autonomous agents</h1>
        <p className="page-subtitle">
          DCA, stop-loss, copy-trade, snipe, position monitor — running 24/7 under your guardrails.
        </p>
      </header>

      <LearningAgentCard />
      <AgentsPanel />
      <AlertsFeed />
    </div>
  );
}
