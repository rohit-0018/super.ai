import AgentsPanel from '../../components/AgentsPanel';
import AlertsFeed from '../../components/AlertsFeed';

export default function AgentsPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Agents & Alerts</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-0.5">
          Autonomous trading agents and real-time alerts.
        </p>
      </header>
      <AgentsPanel />
      <AlertsFeed />
    </div>
  );
}
