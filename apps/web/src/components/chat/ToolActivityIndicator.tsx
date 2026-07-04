// Small shimmer row shown while the agent loop is running a tool
// (`tool_activity { name, status: 'running' }`, ARCHITECTURE §5).
import { useChat } from '../../state/chat';

export function ToolActivityIndicator() {
  const { toolActivity } = useChat();
  if (!toolActivity || toolActivity.status !== 'running') return null;
  return (
    <div className="flex items-center gap-2 px-4 pb-1 text-xs font-medium text-ink-ai">
      <span aria-hidden="true" className="animate-pulse">
        ✦
      </span>
      <span className="animate-pulse">Checking your ledger… ({toolActivity.name})</span>
    </div>
  );
}
